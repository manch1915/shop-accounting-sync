import { Injectable } from '@nestjs/common';
import type { StoreProductRef } from '../../domain/models.js';
import type { ProductMapping } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma.service.js';
import type { FlowContext, FlowHandler, FlowResult } from '../flow.types.js';
import { MappingService } from '../mapping.service.js';

const PUBLISH_PER_RUN = 20;

function refOf(m: ProductMapping): StoreProductRef {
  return {
    productId: m.storeProductId,
    variantId: m.storeVariantId || null,
    inventoryItemId: m.storeInventoryItemId,
  };
}

async function linkedMappings(prisma: PrismaService, integrationId: string) {
  return prisma.productMapping.findMany({ where: { integrationId, accountingProductId: { not: null } } });
}

@Injectable()
export class StockPushFlow implements FlowHandler {
  readonly type = 'stock.push' as const;

  constructor(private readonly prisma: PrismaService) {}

  async run(ctx: FlowContext): Promise<FlowResult> {
    if (!ctx.flags.pushStock) return { skipped: 'Stock sync is turned off for this integration' };
    const levels = await ctx.accounting.getStock(ctx.settings.warehouseId ?? null);
    const byProduct = new Map(levels.map((l) => [l.productExternalId, Math.max(0, Math.floor(l.available))]));
    const mappings = await linkedMappings(this.prisma, ctx.integration.id);

    // only send what changed since the last push, stores rate-limit batch writes too
    const changes = mappings.flatMap((m) => {
      const quantity = byProduct.get(m.accountingProductId ?? '');
      return quantity === undefined || quantity === m.lastStock ? [] : [{ mapping: m, quantity }];
    });
    if (changes.length === 0) return { checked: mappings.length, changed: 0 };

    const result = await ctx.store.updateStock(
      changes.map((c) => ({ ref: refOf(c.mapping), quantity: c.quantity })),
    );
    const failed = new Set(result.failed.map((f) => `${f.ref.productId}:${f.ref.variantId ?? ''}`));
    for (const { mapping, quantity } of changes) {
      if (failed.has(`${mapping.storeProductId}:${mapping.storeVariantId}`)) continue;
      await this.prisma.productMapping.update({ where: { id: mapping.id }, data: { lastStock: quantity } });
    }
    if (result.failed.length > 0) {
      await ctx.log('warn', `${result.failed.length} items were rejected by the store`);
    }
    await ctx.log('info', `Stock updated for ${result.updated} of ${changes.length} changed items`);
    return {
      checked: mappings.length,
      changed: changes.length,
      updated: result.updated,
      failed: result.failed.slice(0, 20),
    };
  }
}

@Injectable()
export class PricePushFlow implements FlowHandler {
  readonly type = 'price.push' as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mapping: MappingService,
  ) {}

  async run(ctx: FlowContext): Promise<FlowResult> {
    if (!ctx.flags.pushPrices) return { skipped: 'Price sync is turned off for this integration' };
    const catalog = await this.mapping.catalog(ctx.integration.id, ctx.accounting, true);
    const prices = new Map(
      catalog.flatMap((p) => (p.priceMinor === null ? [] : [[p.externalId, p.priceMinor]])),
    );
    const mappings = await linkedMappings(this.prisma, ctx.integration.id);
    const changes = mappings.flatMap((m) => {
      const price = prices.get(m.accountingProductId ?? '');
      return price === undefined || price === m.lastPriceMinor ? [] : [{ mapping: m, price }];
    });
    if (changes.length === 0) return { checked: mappings.length, changed: 0 };

    const result = await ctx.store.updatePrices(
      changes.map((c) => ({ ref: refOf(c.mapping), priceMinor: c.price })),
    );
    const failed = new Set(result.failed.map((f) => `${f.ref.productId}:${f.ref.variantId ?? ''}`));
    for (const { mapping, price } of changes) {
      if (failed.has(`${mapping.storeProductId}:${mapping.storeVariantId}`)) continue;
      await this.prisma.productMapping.update({ where: { id: mapping.id }, data: { lastPriceMinor: price } });
    }
    await ctx.log('info', `Prices updated for ${result.updated} of ${changes.length} changed items`);
    return {
      checked: mappings.length,
      changed: changes.length,
      updated: result.updated,
      failed: result.failed.slice(0, 20),
    };
  }
}

@Injectable()
export class ProductPublishFlow implements FlowHandler {
  readonly type = 'product.publish' as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mapping: MappingService,
  ) {}

  async run(ctx: FlowContext): Promise<FlowResult> {
    if (!ctx.flags.publishNewProducts) return { skipped: 'Publishing new products is turned off' };
    const integrationId = ctx.integration.id;
    const catalog = await this.mapping.catalog(integrationId, ctx.accounting, true);
    const linked = new Set(
      (
        await this.prisma.productMapping.findMany({
          where: { integrationId },
          select: { accountingProductId: true },
        })
      )
        .map((m) => m.accountingProductId)
        .filter(Boolean),
    );
    const fresh = catalog
      .filter((p) => !p.archived && p.sku && !linked.has(p.externalId))
      .slice(0, PUBLISH_PER_RUN);
    if (fresh.length === 0) return { created: 0 };

    const stock = new Map(
      (await ctx.accounting.getStock(ctx.settings.warehouseId ?? null)).map((s) => [
        s.productExternalId,
        s.available,
      ]),
    );
    const created: string[] = [];
    for (const product of fresh) {
      const quantity = Math.max(0, Math.floor(stock.get(product.externalId) ?? 0));
      const ref = await ctx.store.createProduct({
        sku: product.sku ?? product.externalId,
        barcode: product.barcodes[0] ?? null,
        name: product.name,
        description: null,
        priceMinor: product.priceMinor ?? 0,
        stock: quantity,
      });
      await this.prisma.productMapping.create({
        data: {
          integrationId,
          storeProductId: ref.productId,
          storeVariantId: ref.variantId ?? '',
          storeInventoryItemId: ref.inventoryItemId ?? null,
          storeSku: product.sku ?? '',
          storeName: product.name,
          barcode: product.barcodes[0] ?? null,
          accountingProductId: product.externalId,
          accountingName: product.name,
          matchedBy: 'sku',
          lastStock: quantity,
          lastPriceMinor: product.priceMinor,
        },
      });
      created.push(product.sku ?? product.externalId);
    }
    await ctx.log('info', `Created ${created.length} draft products in the store`);
    return { created: created.length, skus: created };
  }
}

@Injectable()
export class CatalogRefreshFlow implements FlowHandler {
  readonly type = 'catalog.refresh' as const;

  constructor(private readonly mapping: MappingService) {}

  async run(ctx: FlowContext): Promise<FlowResult> {
    const [storeProducts, catalog] = await Promise.all([
      ctx.store.listProducts(),
      this.mapping.catalog(ctx.integration.id, ctx.accounting, true),
    ]);
    const result = await this.mapping.refresh(ctx.integration.id, storeProducts, catalog);
    await ctx.log(
      'info',
      `Store has ${result.storeProducts} items, ${result.matched} linked, ${result.unmatched} waiting for a match`,
    );
    return { ...result, accountingProducts: catalog.length };
  }
}
