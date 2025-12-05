import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { AccountingConnector } from '../domain/connectors.js';
import { MappingError } from '../domain/errors.js';
import type { CatalogProduct, OrderLine, StoreProduct, TaxRate } from '../domain/models.js';
import type { ProductMapping } from '../generated/prisma/client.js';
import { PrismaService } from '../infra/prisma.service.js';
import { REDIS } from '../infra/redis.js';

const CATALOG_TTL_SEC = 600;

export interface ResolvedLine extends OrderLine {
  accountingProductId: string;
  taxCode: string | null;
}

@Injectable()
export class MappingService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async catalog(
    integrationId: string,
    accounting: AccountingConnector,
    fresh = false,
  ): Promise<CatalogProduct[]> {
    const key = `sas:catalog:${integrationId}`;
    if (!fresh) {
      const cached = await this.redis.get(key);
      if (cached) return JSON.parse(cached) as CatalogProduct[];
    }
    const products = await accounting.listProducts();
    await this.redis.set(key, JSON.stringify(products), 'EX', CATALOG_TTL_SEC);
    return products;
  }

  async taxRates(integrationId: string, accounting: AccountingConnector): Promise<TaxRate[]> {
    const key = `sas:taxrates:${integrationId}`;
    const cached = await this.redis.get(key);
    if (cached) return JSON.parse(cached) as TaxRate[];
    const rates = await accounting.listTaxRates();
    await this.redis.set(key, JSON.stringify(rates), 'EX', CATALOG_TTL_SEC);
    return rates;
  }

  /** Maps every order line to an accounting product and tax code, or throws a MappingError. */
  async resolveLines(
    integrationId: string,
    accounting: AccountingConnector,
    lines: OrderLine[],
  ): Promise<ResolvedLine[]> {
    const resolved: ResolvedLine[] = [];
    for (const line of lines) {
      const productId = await this.resolveProduct(integrationId, accounting, line);
      const taxCode = await this.resolveTax(integrationId, accounting, line.taxRatePercent);
      resolved.push({ ...line, accountingProductId: productId, taxCode });
    }
    return resolved;
  }

  async resolveTax(
    integrationId: string,
    accounting: AccountingConnector,
    ratePercent: number | null,
  ): Promise<string | null> {
    if (ratePercent === null) return null;
    const source = String(ratePercent);
    const mapping = await this.prisma.valueMapping.findUnique({
      where: { integrationId_kind_source: { integrationId, kind: 'tax', source } },
    });
    if (mapping?.target) return mapping.target;

    const candidates = (await this.taxRates(integrationId, accounting)).filter(
      (r) => Math.abs(r.ratePercent - ratePercent) < 0.001,
    );
    // only auto-link when there is exactly one rate with this percentage; UK orgs have several 0% codes
    if (candidates.length === 1 && candidates[0]) {
      const rate = candidates[0];
      await this.prisma.valueMapping.upsert({
        where: { integrationId_kind_source: { integrationId, kind: 'tax', source } },
        create: {
          integrationId,
          kind: 'tax',
          source,
          sourceLabel: `${source}%`,
          target: rate.code,
          targetLabel: rate.name,
        },
        update: { target: rate.code, targetLabel: rate.name },
      });
      return rate.code;
    }
    throw new MappingError(
      'tax_not_mapped',
      source,
      { rate: source, provider: accounting.provider },
      {
        ratePercent,
        candidates: candidates.map((c) => c.code).join(', ') || null,
      },
    );
  }

  private async resolveProduct(
    integrationId: string,
    accounting: AccountingConnector,
    line: OrderLine,
  ): Promise<string> {
    const variantId = line.variantExternalId ?? '';
    const mapping = await this.prisma.productMapping.findUnique({
      where: {
        integrationId_storeProductId_storeVariantId: {
          integrationId,
          storeProductId: line.productExternalId,
          storeVariantId: variantId,
        },
      },
    });
    if (mapping?.accountingProductId) return mapping.accountingProductId;

    const match = matchProduct(
      await this.catalog(integrationId, accounting),
      line.sku,
      mapping?.barcode ?? null,
    );
    if (match) {
      await this.prisma.productMapping.upsert({
        where: {
          integrationId_storeProductId_storeVariantId: {
            integrationId,
            storeProductId: line.productExternalId,
            storeVariantId: variantId,
          },
        },
        create: {
          integrationId,
          storeProductId: line.productExternalId,
          storeVariantId: variantId,
          storeSku: line.sku ?? '',
          storeName: line.name,
          accountingProductId: match.product.externalId,
          accountingName: match.product.name,
          matchedBy: match.by,
        },
        update: {
          accountingProductId: match.product.externalId,
          accountingName: match.product.name,
          matchedBy: match.by,
        },
      });
      return match.product.externalId;
    }

    const key = line.sku || `${line.productExternalId}:${variantId}`;
    throw new MappingError(
      'sku_not_mapped',
      key,
      { sku: line.sku ?? line.name, provider: accounting.provider },
      {
        sku: line.sku,
        name: line.name,
        storeProductId: line.productExternalId,
        storeVariantId: line.variantExternalId,
      },
    );
  }

  /** Pulls both catalogs and links everything that matches unambiguously. */
  async refresh(
    integrationId: string,
    storeProducts: StoreProduct[],
    catalog: CatalogProduct[],
  ): Promise<{ storeProducts: number; matched: number; unmatched: number }> {
    const existing = new Map(
      (await this.prisma.productMapping.findMany({ where: { integrationId } })).map((m) => [
        `${m.storeProductId}:${m.storeVariantId}`,
        m,
      ]),
    );
    let matched = 0;
    for (const p of storeProducts) {
      const current: ProductMapping | undefined = existing.get(`${p.productId}:${p.variantId ?? ''}`);
      const match = current?.accountingProductId ? null : matchProduct(catalog, p.sku, p.barcode);
      if (current?.accountingProductId || match) matched += 1;
      const base = {
        storeSku: p.sku,
        storeName: p.name,
        barcode: p.barcode,
        storeInventoryItemId: p.inventoryItemId ?? null,
      };
      await this.prisma.productMapping.upsert({
        where: {
          integrationId_storeProductId_storeVariantId: {
            integrationId,
            storeProductId: p.productId,
            storeVariantId: p.variantId ?? '',
          },
        },
        create: {
          integrationId,
          storeProductId: p.productId,
          storeVariantId: p.variantId ?? '',
          ...base,
          lastStock: p.stock,
          lastPriceMinor: p.priceMinor,
          ...(match
            ? {
                accountingProductId: match.product.externalId,
                accountingName: match.product.name,
                matchedBy: match.by,
              }
            : {}),
        },
        update: {
          ...base,
          ...(match
            ? {
                accountingProductId: match.product.externalId,
                accountingName: match.product.name,
                matchedBy: match.by,
              }
            : {}),
        },
      });
    }
    return { storeProducts: storeProducts.length, matched, unmatched: storeProducts.length - matched };
  }
}

/** SKU first, then barcode. Ambiguous matches are left for a human. */
export function matchProduct(
  catalog: CatalogProduct[],
  sku: string | null,
  barcode: string | null,
): { product: CatalogProduct; by: 'sku' | 'barcode' } | null {
  const active = catalog.filter((c) => !c.archived);
  if (sku) {
    const bySku = active.filter((c) => c.sku?.trim().toLowerCase() === sku.trim().toLowerCase());
    if (bySku.length === 1 && bySku[0]) return { product: bySku[0], by: 'sku' };
    if (bySku.length > 1) return null;
  }
  if (barcode) {
    const byBarcode = active.filter((c) => c.barcodes.includes(barcode));
    if (byBarcode.length === 1 && byBarcode[0]) return { product: byBarcode[0], by: 'barcode' };
  }
  return null;
}
