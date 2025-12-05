import { Injectable } from '@nestjs/common';
import type { SalesDocumentLine, StoreOrder } from '../../domain/models.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { customerOf, type FlowContext, type FlowHandler, type FlowResult, orderRef } from '../flow.types.js';
import { MappingService } from '../mapping.service.js';
import { OperationService } from '../operation.service.js';
import { enqueuePayment } from './payment-export.flow.js';

@Injectable()
export class OrderExportFlow implements FlowHandler {
  readonly type = 'order.export' as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mapping: MappingService,
    private readonly operations: OperationService,
  ) {}

  async run(ctx: FlowContext): Promise<FlowResult> {
    const orderId = ctx.operation.subjectRef;
    if (!orderId) throw new Error('order.export without an order id');
    if (!ctx.flags.exportOrders) return { skipped: 'Order export is turned off for this integration' };

    const integrationId = ctx.integration.id;
    const link = await this.prisma.entityLink.findUnique({
      where: { integrationId_entity_storeId: { integrationId, entity: 'order', storeId: orderId } },
    });
    if (link) return { skipped: 'Already exported', documentId: link.accountingId, url: link.accountingUrl };

    const order = await ctx.store.getOrder(orderId);
    const ref = orderRef(ctx, order.externalId);
    await ctx.log('info', `Fetched order ${order.number}: ${order.lines.length} lines, ${order.currency}`);

    // the previous attempt may have created the document and then lost the response
    const existing = await ctx.accounting.findSalesDocument(ref);
    if (existing) {
      await ctx.log(
        'warn',
        `Found document ${existing.number ?? existing.externalId} from an earlier attempt`,
      );
      await this.saveLink(integrationId, order.externalId, existing.externalId, existing.url);
      await this.afterExport(ctx, order);
      return { documentId: existing.externalId, number: existing.number, url: existing.url, recovered: true };
    }

    const lines = await this.mapping.resolveLines(integrationId, ctx.accounting, order.lines);
    const shippingTax = order.shipping
      ? await this.mapping.resolveTax(integrationId, ctx.accounting, order.shipping.taxRatePercent)
      : null;
    const customerId = await ctx.accounting.upsertCustomer(customerOf(ctx, order));
    await ctx.log('info', `Customer ${order.customer.email ?? order.customer.lastName} -> ${customerId}`);

    const statusMap = await this.prisma.valueMapping.findUnique({
      where: { integrationId_kind_source: { integrationId, kind: 'status', source: order.status } },
    });

    const doc = await ctx.accounting.createSalesDocument({
      externalRef: ref,
      number: order.number,
      date: order.createdAt,
      currency: order.currency,
      customerId,
      lines: lines.map(
        (l): SalesDocumentLine => ({
          accountingProductId: l.accountingProductId,
          name: l.name,
          quantity: l.quantity,
          unitPriceMinor: l.unitPriceMinor,
          discountPercent: discountPercent(l.discountMinor, l.unitPriceMinor * l.quantity),
          taxCode: l.taxCode,
          taxRatePercent: l.taxRatePercent,
        }),
      ),
      shipping:
        order.shipping && order.shipping.priceMinor > 0
          ? {
              name: order.shipping.title,
              priceMinor: order.shipping.priceMinor,
              taxCode: shippingTax,
              taxRatePercent: order.shipping.taxRatePercent,
            }
          : null,
      pricesIncludeTax: false,
      warehouseId: ctx.settings.warehouseId ?? null,
      statusId: statusMap?.target ?? null,
      comment: [order.note, order.adminUrl].filter(Boolean).join('\n') || null,
    });
    await this.saveLink(integrationId, order.externalId, doc.externalId, doc.url);
    await ctx.log('info', `Created ${doc.number ?? doc.externalId} in ${ctx.accounting.provider}`);
    await this.afterExport(ctx, order);

    return {
      documentId: doc.externalId,
      number: doc.number,
      url: doc.url,
      lines: lines.length,
      totalMinor: order.totalMinor,
      currency: order.currency,
    };
  }

  private async afterExport(ctx: FlowContext, order: StoreOrder): Promise<void> {
    if (order.payment.paid && ctx.flags.exportPayments) {
      await enqueuePayment(this.operations, ctx.integration.id, order.externalId, order.number);
    }
  }

  private async saveLink(integrationId: string, orderId: string, documentId: string, url: string | null) {
    await this.prisma.entityLink.upsert({
      where: { integrationId_entity_storeId: { integrationId, entity: 'order', storeId: orderId } },
      create: {
        integrationId,
        entity: 'order',
        storeId: orderId,
        accountingId: documentId,
        accountingUrl: url,
      },
      update: { accountingId: documentId, accountingUrl: url },
    });
  }
}

export function discountPercent(discountMinor: number, grossMinor: number): number {
  if (discountMinor <= 0 || grossMinor <= 0) return 0;
  return Math.round((discountMinor / grossMinor) * 10_000) / 100;
}

export function enqueueOrder(
  operations: OperationService,
  integrationId: string,
  orderId: string,
  number?: string,
) {
  return operations.enqueue({
    integrationId,
    type: 'order.export',
    subject: `Order #${number ?? orderId}`,
    subjectRef: orderId,
    dedupeKey: `order.export:${integrationId}:${orderId}`,
  });
}
