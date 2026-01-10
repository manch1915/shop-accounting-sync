import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { OperationType } from '@sas/shared';
import type { Queue } from 'bullmq';
import { PrismaService } from '../infra/prisma.service.js';
import { OperationService } from './operation.service.js';
import { QUEUE_SCHEDULER, type ScheduledJob } from './queues.js';

const SUBJECTS: Partial<Record<OperationType, string>> = {
  'orders.reconcile': 'Order reconciliation',
  'stock.push': 'Stock levels to store',
  'price.push': 'Prices to store',
  'product.publish': 'New products to store',
  'catalog.refresh': 'Catalog refresh and auto-matching',
};

/** Periodic jobs per integration. Webhooks do the real-time work, these catch everything else. */
@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationService,
    @InjectQueue(QUEUE_SCHEDULER) private readonly queue: Queue,
  ) {}

  async syncSchedules(): Promise<void> {
    const integrations = await this.prisma.integration.findMany();
    for (const integration of integrations) {
      const plan: Array<[OperationType, number]> = [
        ['orders.reconcile', integration.reconcileEveryMin * 60_000],
        ['stock.push', 10 * 60_000],
        ['price.push', 60 * 60_000],
        ['product.publish', 6 * 60 * 60_000],
        ['catalog.refresh', 6 * 60 * 60_000],
      ];
      for (const [type, every] of plan) {
        const data: ScheduledJob = { integrationId: integration.id, type };
        await this.queue.upsertJobScheduler(`${type}:${integration.id}`, { every }, { name: type, data });
      }
    }
    this.logger.log(`Schedules registered for ${integrations.length} integrations`);

    // a fresh integration has no product links yet; build them now instead of in six hours
    for (const integration of integrations) {
      const linked = await this.prisma.productMapping.count({ where: { integrationId: integration.id } });
      if (linked === 0) await this.fire({ integrationId: integration.id, type: 'catalog.refresh' });
    }
  }

  /** Called by the scheduler worker and by webhooks that ask for an early run (stock changed). */
  async fire({ integrationId, type }: ScheduledJob, slotMs = 60_000): Promise<unknown> {
    const slot = Math.floor(Date.now() / slotMs);
    return this.operations.enqueue({
      integrationId,
      type,
      subject: SUBJECTS[type] ?? type,
      dedupeKey: `${type}:${integrationId}:${slot}`,
    });
  }
}
