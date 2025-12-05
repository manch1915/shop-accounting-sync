import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma.service.js';
import type { FlowContext, FlowHandler, FlowResult } from '../flow.types.js';
import { OperationService } from '../operation.service.js';
import { enqueueOrder } from './order-export.flow.js';
import { enqueuePayment } from './payment-export.flow.js';

const PAGE = 100;
const FIRST_RUN_LOOKBACK_MS = 24 * 3600 * 1000;
// overlap windows a little, stores stamp modification times with second precision
const OVERLAP_MS = 60 * 1000;

/** Catches orders whose webhooks never arrived: stores disable webhooks after a few failures. */
@Injectable()
export class ReconcileFlow implements FlowHandler {
  readonly type = 'orders.reconcile' as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationService,
  ) {}

  async run(ctx: FlowContext): Promise<FlowResult> {
    const integrationId = ctx.integration.id;
    const since = new Date(
      (ctx.integration.reconciledUntil?.getTime() ?? Date.now() - FIRST_RUN_LOOKBACK_MS) - OVERLAP_MS,
    );
    const orders = await ctx.store.listOrdersUpdatedSince(since, PAGE);
    const links = await this.prisma.entityLink.findMany({
      where: { integrationId, storeId: { in: orders.map((o) => o.externalId) } },
      select: { entity: true, storeId: true },
    });
    const has = new Set(links.map((l) => `${l.entity}:${l.storeId}`));

    let queued = 0;
    for (const order of orders) {
      if (!has.has(`order:${order.externalId}`) && ctx.flags.exportOrders) {
        const res = await enqueueOrder(this.operations, integrationId, order.externalId, order.number);
        if (res.created) queued += 1;
      } else if (order.payment.paid && ctx.flags.exportPayments && !has.has(`payment:${order.externalId}`)) {
        const res = await enqueuePayment(this.operations, integrationId, order.externalId, order.number);
        if (res.created) queued += 1;
      }
    }

    const latest = orders.reduce(
      (max, o) => Math.max(max, o.updatedAt.getTime()),
      since.getTime() + OVERLAP_MS,
    );
    await this.prisma.integration.update({
      where: { id: integrationId },
      data: { reconciledUntil: new Date(latest) },
    });
    if (queued > 0) await ctx.log('warn', `Found ${queued} orders that webhooks missed, queued them`);
    return { scanned: orders.length, queued, since: since.toISOString() };
  }
}
