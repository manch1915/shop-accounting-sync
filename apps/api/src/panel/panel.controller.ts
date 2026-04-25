import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { OPERATION_TYPES, type OperationType } from '@sas/shared';
import { z } from 'zod';
import { Allow, Session } from '../auth/auth.guard.js';
import type { SessionClaims } from '../auth/session-token.js';
import { PrismaService } from '../infra/prisma.service.js';
import { ConflictService } from '../sync/conflict.service.js';
import { OperationService } from '../sync/operation.service.js';
import { SchedulerService } from '../sync/scheduler.service.js';
import { PanelQueryService } from './panel-query.service.js';
import { ZodBody } from './zod.pipe.js';

// 'retrying' is left out on purpose: it still has a live job, the runner would race it
const RETRYABLE_STATUSES = ['dead', 'blocked', 'skipped'];
const resolveSchema = z.object({
  target: z.string().min(1).max(200),
  targetLabel: z.string().min(1).max(300),
});
const bulkRetrySchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(200) });

@Controller('api')
export class PanelController {
  constructor(
    private readonly query: PanelQueryService,
    private readonly prisma: PrismaService,
    private readonly operations: OperationService,
    private readonly conflicts: ConflictService,
    private readonly scheduler: SchedulerService,
  ) {}

  @Get('overview')
  overview(@Session() s: SessionClaims, @Query('days') days?: string) {
    const span = Math.min(Math.max(Math.trunc(Number(days)) || 14, 1), 90);
    return this.query.stats(s.ws, span);
  }

  @Get('integrations')
  integrations(@Session() s: SessionClaims) {
    return this.query.integrations(s.ws);
  }

  @Get('connections')
  connections(@Session() s: SessionClaims) {
    return this.query.connections(s.ws);
  }

  @Get('operations')
  operationList(
    @Session() s: SessionClaims,
    @Query('status') status?: string,
    @Query('type') type?: string,
    @Query('integrationId') integrationId?: string,
    @Query('q') q?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.query.operations(s.ws, {
      status,
      type,
      integrationId,
      q: q?.trim().slice(0, 100) || undefined,
      cursor,
      limit: Math.min(Math.max(Number(limit) || 50, 1), 200),
    });
  }

  @Get('operations/:id')
  operation(@Session() s: SessionClaims, @Param('id') id: string) {
    return this.query.operation(s.ws, id);
  }

  @Post('operations/:id/retry')
  @HttpCode(202)
  @Allow('safe-action')
  async retry(@Session() s: SessionClaims, @Param('id') id: string) {
    await this.retryOwned(s.ws, [id]);
    return { queued: 1 };
  }

  @Post('operations/retry')
  @HttpCode(202)
  @Allow('safe-action')
  async retryMany(
    @Session() s: SessionClaims,
    @Body(new ZodBody(bulkRetrySchema)) body: z.infer<typeof bulkRetrySchema>,
  ) {
    return { queued: await this.retryOwned(s.ws, body.ids) };
  }

  @Get('errors')
  errors(@Session() s: SessionClaims) {
    return this.query.errorGroups(s.ws);
  }

  @Get('conflicts')
  conflictList(@Session() s: SessionClaims, @Query('status') status?: string) {
    return this.query.conflicts(s.ws, status === 'resolved' ? 'resolved' : 'open');
  }

  @Get('conflicts/:id/candidates')
  candidates(@Session() s: SessionClaims, @Param('id') id: string, @Query('q') q?: string) {
    return this.query.candidates(s.ws, id, q?.slice(0, 100) ?? '');
  }

  @Post('conflicts/:id/resolve')
  @HttpCode(200)
  @Allow('safe-action')
  async resolve(
    @Session() s: SessionClaims,
    @Param('id') id: string,
    @Body(new ZodBody(resolveSchema)) body: z.infer<typeof resolveSchema>,
  ) {
    const owned = await this.prisma.conflict.findFirst({ where: { id, integration: { workspaceId: s.ws } } });
    if (!owned) throw new NotFoundException();
    return this.conflicts.resolve(id, body);
  }

  @Get('mappings/products')
  products(
    @Session() s: SessionClaims,
    @Query('integrationId') integrationId?: string,
    @Query('q') q?: string,
    @Query('unmatched') unmatched?: string,
  ) {
    return this.query.productMappings(s.ws, integrationId, q?.slice(0, 100), unmatched === 'true');
  }

  @Get('mappings/values')
  values(@Session() s: SessionClaims, @Query('integrationId') integrationId?: string) {
    return this.query.valueMappings(s.ws, integrationId);
  }

  @Get('alerts')
  alerts(@Session() s: SessionClaims) {
    return this.query.alerts(s.ws);
  }

  @Post('integrations/:id/run/:type')
  @HttpCode(202)
  @Allow('safe-action')
  async runNow(@Session() s: SessionClaims, @Param('id') id: string, @Param('type') type: string) {
    const runnable: OperationType[] = ['orders.reconcile', 'stock.push', 'price.push', 'catalog.refresh'];
    if (!(OPERATION_TYPES as readonly string[]).includes(type) || !runnable.includes(type as OperationType)) {
      throw new NotFoundException();
    }
    const integration = await this.prisma.integration.findFirst({ where: { id, workspaceId: s.ws } });
    if (!integration) throw new NotFoundException();
    // a 10 s slot keeps a nervous double-click from queueing the same run twice
    return this.scheduler.fire({ integrationId: id, type: type as OperationType }, 10_000);
  }

  private async retryOwned(workspaceId: string, ids: string[]): Promise<number> {
    const ops = await this.prisma.operation.findMany({
      where: { id: { in: ids }, integration: { workspaceId }, status: { in: RETRYABLE_STATUSES } },
      select: { id: true },
    });
    if (ops.length === 0 && ids.length === 1) throw new NotFoundException('Nothing to retry');
    for (const op of ops) await this.operations.requeue(op.id, 'Retried from the dashboard');
    return ops.length;
  }
}
