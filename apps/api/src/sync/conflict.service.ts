import { Inject, Injectable } from '@nestjs/common';
import type { LiveEvent } from '@sas/shared';
import type { Redis } from 'ioredis';
import { AlertService } from '../alerts/alert.service.js';
import type { MappingError } from '../domain/errors.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../infra/prisma.service.js';
import { LIVE_CHANNEL, REDIS } from '../infra/redis.js';
import { OperationService } from './operation.service.js';

export interface ConflictResolution {
  target: string;
  targetLabel: string;
}

@Injectable()
export class ConflictService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationService,
    private readonly alerts: AlertService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async open(integrationId: string, err: MappingError): Promise<string> {
    const where = { integrationId_kind_key: { integrationId, kind: err.code, key: err.conflictKey } };
    const before = await this.prisma.conflict.findUnique({ where });
    const conflict = await this.prisma.conflict.upsert({
      where,
      create: {
        integrationId,
        kind: err.code,
        key: err.conflictKey,
        details: { ...err.details, ...err.params } as Prisma.InputJsonValue,
      },
      update: { status: 'open', resolvedAt: null },
    });
    if (before?.status !== 'open') {
      const integration = await this.prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
      await this.alerts.raise(integration.workspaceId, {
        severity: 'warning',
        title: `${integration.name}: needs a mapping`,
        body: `${err.message}. Orders with it are on hold until it is linked on the Conflicts page.`,
        dedupeKey: `conflict:${conflict.id}`,
      });
      await this.publish(conflict.id, false);
    }
    return conflict.id;
  }

  /** Stores the mapping a person picked and resumes every operation that waited on it. */
  async resolve(conflictId: string, resolution: ConflictResolution): Promise<{ resumed: number }> {
    const conflict = await this.prisma.conflict.findUniqueOrThrow({ where: { id: conflictId } });
    const details = conflict.details as Record<string, string | null>;

    if (conflict.kind === 'sku_not_mapped') {
      const storeProductId = details.storeProductId;
      if (!storeProductId) throw new Error('Conflict has no store product id');
      const key = {
        integrationId: conflict.integrationId,
        storeProductId,
        storeVariantId: details.storeVariantId ?? '',
      };
      await this.prisma.productMapping.upsert({
        where: { integrationId_storeProductId_storeVariantId: key },
        create: {
          ...key,
          storeSku: details.sku ?? '',
          storeName: details.name ?? conflict.key,
          accountingProductId: resolution.target,
          accountingName: resolution.targetLabel,
          matchedBy: 'manual',
        },
        update: {
          accountingProductId: resolution.target,
          accountingName: resolution.targetLabel,
          matchedBy: 'manual',
        },
      });
    } else if (conflict.kind === 'tax_not_mapped') {
      const key = { integrationId: conflict.integrationId, kind: 'tax', source: conflict.key };
      await this.prisma.valueMapping.upsert({
        where: { integrationId_kind_source: key },
        create: {
          ...key,
          sourceLabel: `${conflict.key}%`,
          target: resolution.target,
          targetLabel: resolution.targetLabel,
        },
        update: { target: resolution.target, targetLabel: resolution.targetLabel },
      });
    }

    await this.prisma.conflict.update({
      where: { id: conflictId },
      data: { status: 'resolved', resolvedAt: new Date(), resolution: { ...resolution } },
    });
    const blocked = await this.prisma.operation.findMany({
      where: { conflictId, status: 'blocked' },
      select: { id: true },
    });
    for (const op of blocked) {
      await this.operations.requeue(op.id, `Mapping added (${resolution.targetLabel}), resuming`);
    }
    await this.publish(conflictId, true);
    return { resumed: blocked.length };
  }

  private async publish(conflictId: string, resolved: boolean): Promise<void> {
    const event: LiveEvent = { type: 'conflict', conflictId, resolved };
    await this.redis.publish(LIVE_CHANNEL, JSON.stringify(event));
  }
}
