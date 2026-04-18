import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma.service.js';
import { customerOf, type FlowContext, type FlowHandler, type FlowResult } from '../flow.types.js';
import { OperationService } from '../operation.service.js';
import { enqueueOrder } from './order-export.flow.js';

@Injectable()
export class PaymentExportFlow implements FlowHandler {
  readonly type = 'payment.export' as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationService,
  ) {}

  async run(ctx: FlowContext): Promise<FlowResult> {
    const orderId = ctx.operation.subjectRef;
    if (!orderId) throw new Error('payment.export without an order id');
    if (!ctx.flags.exportPayments) return { skipped: 'Payment export is turned off for this integration' };
    const integrationId = ctx.integration.id;

    const [orderLink, paymentLink] = await Promise.all(
      ['order', 'payment'].map((entity) =>
        this.prisma.entityLink.findUnique({
          where: { integrationId_entity_storeId: { integrationId, entity, storeId: orderId } },
        }),
      ),
    );
    if (paymentLink) return { skipped: 'Payment already registered', paymentId: paymentLink.accountingId };
    if (!orderLink) {
      // the order export queues the payment itself once the document exists
      await enqueueOrder(this.operations, integrationId, orderId);
      return { skipped: 'Order is not in accounting yet; it was queued and will bring the payment along' };
    }

    const order = await ctx.store.getOrder(orderId);
    await ctx.rename(`Payment for #${order.number}`);
    if (!order.payment.paid) return { skipped: 'Order is not paid yet' };

    const customerId = await ctx.accounting.upsertCustomer(customerOf(ctx, order));
    const payment = await ctx.accounting.registerPayment({
      document: { externalId: orderLink.accountingId, number: null, url: orderLink.accountingUrl },
      customerId,
      amountMinor: order.totalMinor,
      currency: order.currency,
      paidAt: order.payment.paidAt ?? order.updatedAt,
      reference:
        [order.payment.method, order.payment.transactionId].filter(Boolean).join(' ') || order.number,
    });
    await this.prisma.entityLink.create({
      data: {
        integrationId,
        entity: 'payment',
        storeId: orderId,
        accountingId: payment.externalId,
        accountingUrl: payment.url,
      },
    });
    await ctx.log('info', `Payment ${payment.number ?? payment.externalId} linked to the order document`);
    return {
      paymentId: payment.externalId,
      url: payment.url,
      amountMinor: order.totalMinor,
      currency: order.currency,
    };
  }
}

export function enqueuePayment(
  operations: OperationService,
  integrationId: string,
  orderId: string,
  number?: string,
) {
  return operations.enqueue({
    integrationId,
    type: 'payment.export',
    subject: `Payment for #${number ?? orderId}`,
    subjectRef: orderId,
    dedupeKey: `payment.export:${integrationId}:${orderId}`,
  });
}
