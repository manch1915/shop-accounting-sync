import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  AlertDto,
  ConflictDto,
  ConflictKind,
  ConnectionDto,
  ConnectionStatus,
  ErrorCode,
  ErrorGroupDto,
  HttpExchangeDto,
  IntegrationDto,
  IntegrationFlags,
  MatchMethod,
  OperationDetailDto,
  OperationDto,
  Page,
  ProductMappingDto,
  Provider,
  StatsDto,
  ValueMappingDto,
} from '@sas/shared';
import { ConnectorService } from '../connectors/connector.service.js';
import type { CatalogProduct } from '../domain/models.js';
import type { Connection, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../infra/prisma.service.js';
import { toOperationDto } from '../journal/operation.mapper.js';
import { MappingService } from '../sync/mapping.service.js';
import { rankCandidates } from './similarity.js';

export interface OperationFilter {
  status?: string;
  type?: string;
  integrationId?: string;
  q?: string;
  cursor?: string;
  limit: number;
}

interface DailyRow {
  day: Date;
  synced: bigint;
  failed: bigint;
  operations: bigint;
  errors: bigint;
  p50: number | null;
  p95: number | null;
}

const withIntegration = { integration: { select: { name: true } } } as const;
const MAX_CACHE_ENTRIES = 1000;

@Injectable()
export class PanelQueryService {
  // aggregates over thousands of operations; the live feed carries what happened in the last seconds
  private readonly cache = new Map<string, { until: number; value: Promise<unknown> }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorService,
    private readonly mapping: MappingService,
  ) {}

  async connections(workspaceId: string): Promise<ConnectionDto[]> {
    const rows = await this.prisma.connection.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
    });
    return Promise.all(rows.map((c) => this.connectionDto(c)));
  }

  integrations(workspaceId: string): Promise<IntegrationDto[]> {
    return this.cached(`integrations:${workspaceId}`, () => this.loadIntegrations(workspaceId));
  }

  stats(workspaceId: string, days: number): Promise<StatsDto> {
    return this.cached(`stats:${workspaceId}:${days}`, () => this.loadStats(workspaceId, days));
  }

  private cached<T>(key: string, load: () => Promise<T>, ttlMs = 10_000): Promise<T> {
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.until > now) return hit.value as Promise<T>;
    // keys are bounded by workspaces x 90 day spans; still sweep, and never let it grow past a cap
    for (const [k, entry] of this.cache) if (entry.until <= now) this.cache.delete(k);
    if (this.cache.size >= MAX_CACHE_ENTRIES) this.cache.clear();
    const value = load().catch((err: unknown) => {
      this.cache.delete(key);
      throw err;
    });
    this.cache.set(key, { until: Date.now() + ttlMs, value });
    return value;
  }

  private async loadIntegrations(workspaceId: string): Promise<IntegrationDto[]> {
    const rows = await this.prisma.integration.findMany({
      where: { workspaceId },
      include: { store: true, accounting: true },
      orderBy: { createdAt: 'asc' },
    });
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    return Promise.all(
      rows.map(async (i) => {
        const [orders, failed, p95] = await Promise.all([
          this.prisma.operation.count({
            where: { integrationId: i.id, type: 'order.export', createdAt: { gte: since } },
          }),
          this.prisma.operation.count({
            where: { integrationId: i.id, status: { in: ['dead', 'blocked'] }, createdAt: { gte: since } },
          }),
          this.prisma.$queryRaw<Array<{ p95: number | null }>>`
            select percentile_cont(0.95) within group (order by extract(epoch from ("finishedAt" - "createdAt")) * 1000 - "waitedMs") as p95
            from "Operation"
            where "integrationId" = ${i.id} and type = 'order.export' and status = 'succeeded' and "createdAt" >= ${since}`,
        ]);
        return {
          id: i.id,
          name: i.name,
          store: (await this.connectionDto(i.store)) as IntegrationDto['store'],
          accounting: (await this.connectionDto(i.accounting)) as IntegrationDto['accounting'],
          flags: i.flags as unknown as IntegrationFlags,
          currency: i.currency,
          reconcileEveryMin: i.reconcileEveryMin,
          stats24h: { orders, failed, p95Ms: roundOrNull(p95[0]?.p95) },
        };
      }),
    );
  }

  async operations(workspaceId: string, filter: OperationFilter): Promise<Page<OperationDto>> {
    const where: Prisma.OperationWhereInput = {
      integration: { workspaceId },
      ...(filter.status ? { status: { in: filter.status.split(',') } } : {}),
      ...(filter.type ? { type: { in: filter.type.split(',') } } : {}),
      ...(filter.integrationId ? { integrationId: filter.integrationId } : {}),
      ...(filter.q
        ? {
            OR: [
              { subject: { contains: filter.q, mode: 'insensitive' } },
              { subjectRef: filter.q },
              { errorDetail: { contains: filter.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.operation.findMany({
        where,
        include: withIntegration,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: filter.limit + 1,
        ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
      }),
      this.prisma.operation.count({ where }),
    ]);
    const items = rows.slice(0, filter.limit).map(toOperationDto);
    return { items, total, nextCursor: rows.length > filter.limit ? (items.at(-1)?.id ?? null) : null };
  }

  async operation(workspaceId: string, id: string): Promise<OperationDetailDto> {
    const op = await this.prisma.operation.findFirst({
      where: { id, integration: { workspaceId } },
      include: {
        ...withIntegration,
        events: { orderBy: { at: 'asc' } },
        exchanges: { orderBy: { createdAt: 'asc' }, include: { connection: { select: { provider: true } } } },
      },
    });
    if (!op) throw new NotFoundException();
    return {
      ...toOperationDto(op),
      payload: op.payload,
      result: op.result,
      events: op.events.map((e) => ({
        id: e.id,
        at: e.at.toISOString(),
        level: e.level as 'info' | 'warn' | 'error',
        message: e.message,
      })),
      exchanges: op.exchanges.map(
        (x): HttpExchangeDto => ({
          id: x.id,
          attempt: x.attempt,
          provider: x.connection.provider as Provider,
          method: x.method,
          url: x.url,
          requestHeaders: x.requestHeaders as Record<string, string>,
          requestBody: x.requestBody,
          status: x.status,
          responseHeaders: x.responseHeaders as Record<string, string>,
          responseBody: x.responseBody,
          durationMs: x.durationMs,
          error: x.error,
          createdAt: x.createdAt.toISOString(),
        }),
      ),
    };
  }

  /** Dead jobs grouped by cause, so 40 identical failures show up as one row with "retry 40". */
  async errorGroups(workspaceId: string): Promise<ErrorGroupDto[]> {
    const dead = await this.prisma.operation.findMany({
      where: { integration: { workspaceId }, status: 'dead' },
      include: { integration: { select: { name: true, store: true, accounting: true } } },
      orderBy: { updatedAt: 'desc' },
      take: 500,
    });
    const groups = new Map<string, ErrorGroupDto>();
    for (const op of dead) {
      const params = (op.errorParams ?? {}) as Record<string, string | number>;
      const provider =
        (params.provider as Provider | undefined) ?? (op.integration.accounting.provider as Provider);
      const key = `${op.errorCode}:${provider}:${op.integrationId}:${op.type}`;
      const group = groups.get(key);
      if (group) {
        group.count += 1;
        group.operationIds.push(op.id);
      } else {
        groups.set(key, {
          errorCode: (op.errorCode ?? 'unknown') as ErrorCode,
          provider,
          params,
          count: 1,
          lastSeenAt: op.updatedAt.toISOString(),
          operationIds: [op.id],
          sample: toOperationDto(op),
        });
      }
    }
    return [...groups.values()];
  }

  async conflicts(workspaceId: string, status: string): Promise<ConflictDto[]> {
    const rows = await this.prisma.conflict.findMany({
      where: { integration: { workspaceId }, status },
      include: {
        integration: { include: { accounting: true } },
        _count: { select: { operations: { where: { status: 'blocked' } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return Promise.all(
      rows.map(async (c): Promise<ConflictDto> => {
        const details = c.details as Record<string, string | number | null>;
        return {
          id: c.id,
          integrationId: c.integrationId,
          integrationName: c.integration.name,
          kind: c.kind as ConflictKind,
          key: c.key,
          details,
          blockedOperations: c._count.operations,
          createdAt: c.createdAt.toISOString(),
          suggestions: c.status === 'open' ? await this.suggestions(c.integration, c.kind, details) : [],
        };
      }),
    );
  }

  async candidates(workspaceId: string, conflictId: string, q: string) {
    const conflict = await this.prisma.conflict.findFirst({
      where: { id: conflictId, integration: { workspaceId } },
      include: { integration: { include: { accounting: true } } },
    });
    if (!conflict) throw new NotFoundException();
    if (conflict.kind === 'tax_not_mapped') {
      const rates = await this.mapping.taxRates(
        conflict.integrationId,
        this.connectors.accounting(conflict.integration.accounting),
      );
      return rates.map((r) => ({ externalId: r.code, label: r.name, hint: `${r.ratePercent}%`, score: 0 }));
    }
    const catalog = await this.catalog(conflict.integration);
    const needle = q.trim().toLowerCase();
    return catalog
      .filter((p) => !p.archived)
      .filter(
        (p) => !needle || p.name.toLowerCase().includes(needle) || p.sku?.toLowerCase().includes(needle),
      )
      .slice(0, 30)
      .map((p) => ({ externalId: p.externalId, label: p.name, hint: p.sku, score: 0 }));
  }

  async productMappings(
    workspaceId: string,
    integrationId: string | undefined,
    q: string | undefined,
    onlyUnmatched: boolean,
  ): Promise<ProductMappingDto[]> {
    const rows = await this.prisma.productMapping.findMany({
      where: {
        integration: { workspaceId },
        ...(integrationId ? { integrationId } : {}),
        ...(onlyUnmatched ? { accountingProductId: null } : {}),
        ...(q
          ? {
              OR: [
                { storeSku: { contains: q, mode: 'insensitive' } },
                { storeName: { contains: q, mode: 'insensitive' } },
                { accountingName: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ accountingProductId: { sort: 'asc', nulls: 'first' } }, { storeName: 'asc' }],
      take: 300,
    });
    return rows.map((m) => ({
      id: m.id,
      integrationId: m.integrationId,
      storeSku: m.storeSku,
      storeName: m.storeName,
      storeProductId: m.storeProductId,
      accountingProductId: m.accountingProductId,
      accountingName: m.accountingName,
      matchedBy: m.matchedBy as MatchMethod | null,
      barcode: m.barcode,
      stock: m.lastStock,
      priceMinor: m.lastPriceMinor,
      updatedAt: m.updatedAt.toISOString(),
    }));
  }

  async valueMappings(workspaceId: string, integrationId?: string): Promise<ValueMappingDto[]> {
    const rows = await this.prisma.valueMapping.findMany({
      where: { integration: { workspaceId }, ...(integrationId ? { integrationId } : {}) },
      orderBy: [{ kind: 'asc' }, { source: 'asc' }],
    });
    return rows.map((v) => ({
      id: v.id,
      integrationId: v.integrationId,
      kind: v.kind as ValueMappingDto['kind'],
      source: v.source,
      sourceLabel: v.sourceLabel,
      target: v.target,
      targetLabel: v.targetLabel,
    }));
  }

  async alerts(workspaceId: string): Promise<AlertDto[]> {
    const rows = await this.prisma.alert.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((a) => ({
      id: a.id,
      channel: a.channel as AlertDto['channel'],
      severity: a.severity as AlertDto['severity'],
      title: a.title,
      body: a.body,
      delivered: a.delivered,
      createdAt: a.createdAt.toISOString(),
    }));
  }

  private async loadStats(workspaceId: string, days: number): Promise<StatsDto> {
    const from = new Date();
    from.setUTCHours(0, 0, 0, 0);
    from.setUTCDate(from.getUTCDate() - (days - 1));
    const rows = await this.prisma.$queryRaw<DailyRow[]>`
      select date_trunc('day', o."createdAt") as day,
        count(*) filter (where o.type = 'order.export' and o.status = 'succeeded') as synced,
        count(*) filter (where o.type = 'order.export' and o.status in ('dead', 'blocked')) as failed,
        count(*) as operations,
        count(*) filter (where o.status in ('dead', 'blocked') or o.attempts > 1) as errors,
        percentile_cont(0.5) within group (order by extract(epoch from (o."finishedAt" - o."createdAt")) * 1000 - o."waitedMs")
          filter (where o.type = 'order.export' and o.status = 'succeeded') as p50,
        percentile_cont(0.95) within group (order by extract(epoch from (o."finishedAt" - o."createdAt")) * 1000 - o."waitedMs")
          filter (where o.type = 'order.export' and o.status = 'succeeded') as p95
      from "Operation" o
      join "Integration" i on i.id = o."integrationId"
      where i."workspaceId" = ${workspaceId} and o."createdAt" >= ${from}
      group by 1
      order by 1`;

    const byDay = new Map(rows.map((r) => [r.day.toISOString().slice(0, 10), r]));
    const daily: StatsDto['daily'] = [];
    for (let d = 0; d < days; d++) {
      const date = new Date(from.getTime() + d * 86_400_000).toISOString().slice(0, 10);
      const r = byDay.get(date);
      daily.push({
        date,
        ordersSynced: Number(r?.synced ?? 0),
        ordersFailed: Number(r?.failed ?? 0),
        operations: Number(r?.operations ?? 0),
        errors: Number(r?.errors ?? 0),
        p50Ms: roundOrNull(r?.p50),
        p95Ms: roundOrNull(r?.p95),
      });
    }

    const scope = { integration: { workspaceId } };
    const [openConflicts, deadJobs, retryingJobs, p95All] = await Promise.all([
      this.prisma.conflict.count({ where: { ...scope, status: 'open' } }),
      this.prisma.operation.count({ where: { ...scope, status: 'dead' } }),
      this.prisma.operation.count({ where: { ...scope, status: 'retrying' } }),
      this.prisma.$queryRaw<Array<{ p95: number | null }>>`
        select percentile_cont(0.95) within group (order by extract(epoch from (o."finishedAt" - o."createdAt")) * 1000 - o."waitedMs") as p95
        from "Operation" o join "Integration" i on i.id = o."integrationId"
        where i."workspaceId" = ${workspaceId} and o.type = 'order.export' and o.status = 'succeeded'
          and o."createdAt" >= ${from}`,
    ]);
    const synced = daily.reduce((s, d) => s + d.ordersSynced, 0);
    const failed = daily.reduce((s, d) => s + d.ordersFailed, 0);
    return {
      range: { from: from.toISOString(), to: new Date().toISOString() },
      totals: {
        ordersSynced: synced,
        ordersFailed: failed,
        successRate: synced + failed === 0 ? 1 : synced / (synced + failed),
        p95Ms: roundOrNull(p95All[0]?.p95),
        openConflicts,
        deadJobs,
        retryingJobs,
      },
      daily,
    };
  }

  private async connectionDto(c: Connection): Promise<ConnectionDto> {
    return {
      id: c.id,
      provider: c.provider as Provider,
      kind: c.kind as ConnectionDto['kind'],
      name: c.name,
      baseUrl: c.baseUrl,
      status: c.status as ConnectionStatus,
      statusReason: c.statusReason,
      lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
      authType: c.authType as ConnectionDto['authType'],
      tokenExpiresAt: c.tokenExpiresAt?.toISOString() ?? null,
      rateLimit: await this.connectors.rateUsage(c),
    };
  }

  private async catalog(integration: { id: string; accounting: Connection }): Promise<CatalogProduct[]> {
    return this.mapping.catalog(integration.id, this.connectors.accounting(integration.accounting));
  }

  private async suggestions(
    integration: { id: string; accounting: Connection },
    kind: string,
    details: Record<string, string | number | null>,
  ): Promise<ConflictDto['suggestions']> {
    if (kind !== 'sku_not_mapped') return [];
    try {
      const catalog = await this.catalog(integration);
      return rankCandidates(catalog, String(details.name ?? ''), String(details.sku ?? '')).slice(0, 3);
    } catch {
      // suggestions are a nicety; the provider may be down, the list still renders
      return [];
    }
  }
}

function roundOrNull(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : Math.round(Number(value));
}
