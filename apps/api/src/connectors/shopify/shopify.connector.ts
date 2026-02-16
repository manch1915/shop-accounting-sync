import { createHash } from 'node:crypto';
import type { ConnectorContext, StoreConnector, StoreConnectorFactory } from '../../domain/connectors.js';
import { NotFoundError, ValidationRejectedError } from '../../domain/errors.js';
import type {
  Address,
  BatchResult,
  IncomingWebhook,
  NewStoreProduct,
  OrderLine,
  Shipping,
  StoreOrder,
  StoreProduct,
  StoreProductRef,
  WebhookEvent,
  WebhookTopic,
} from '../../domain/models.js';
import { fromMinor, toMinor } from '../../domain/money.js';
import { hmacSha256, safeEqual } from '../../security/hmac.js';
import { currentJournalScope, type ErrorPolicy, parseRetryAfter } from '../http/http-client.js';
import {
  INVENTORY_SET_MUTATION,
  ORDER_IDS_QUERY,
  ORDER_QUERY,
  PRODUCT_CREATE_MUTATION,
  VARIANTS_BULK_UPDATE_MUTATION,
  VARIANTS_QUERY,
} from './shopify.queries.js';
import type {
  GqlAddress,
  GqlError,
  GqlLineItem,
  GqlOrder,
  GqlResponse,
  GqlShippingLine,
  GqlTaxLine,
  GqlVariant,
  InventorySetMutation,
  MoneyBag,
  OrderIdsQuery,
  OrderQuery,
  ProductCreateMutation,
  ShopifyWebhookBody,
  UserError,
  VariantsBulkUpdateMutation,
  VariantsQuery,
} from './shopify.types.js';

// Shopify caps input arrays at 250 items
const INPUT_LIMIT = 250;
// each order is fetched in full (~650 cost points), so a reconciliation pass takes a small bite;
// the next pass continues from the newest order seen
const ORDERS_PAGE = 20;
// variant nodes cost ~6 points each, 100 keeps the page under the 1000-point query limit
const VARIANTS_PAGE = 100;
const MIN_THROTTLE_MS = 1000;
const FALLBACK_RETRY_MS = 2000;
const PAID_STATUSES = new Set(['PAID', 'PARTIALLY_REFUNDED']);
const PAYMENT_KINDS = new Set(['SALE', 'CAPTURE']);

type GidType = 'Order' | 'Product' | 'ProductVariant' | 'InventoryItem' | 'Location';

const TOPICS: Record<string, WebhookTopic> = {
  'orders/create': 'order.created',
  'orders/updated': 'order.updated',
  'orders/paid': 'order.paid',
  'products/create': 'product.created',
  'products/update': 'product.updated',
};

function parseJson(body: string): GqlResponse<unknown> | null {
  try {
    return JSON.parse(body) as GqlResponse<unknown>;
  } catch {
    return null;
  }
}

function errorList(response: GqlResponse<unknown> | null): GqlError[] {
  return Array.isArray(response?.errors) ? response.errors : [];
}

export const shopifyErrorPolicy: ErrorPolicy = {
  retryAfterMs: (headers) => parseRetryAfter(headers.get('retry-after'), FALLBACK_RETRY_MS),
  extractMessage: (body) => {
    const parsed = parseJson(body);
    if (typeof parsed?.errors === 'string') return parsed.errors;
    const messages = errorList(parsed).map((e) => e.message);
    return messages.length ? messages.join('; ') : null;
  },
  // GraphQL throttling comes back as HTTP 200 with a THROTTLED error, not as a 429
  detectThrottle: (_status, body) => {
    if (!body.includes('THROTTLED')) return null;
    const parsed = parseJson(body);
    if (!errorList(parsed).some((e) => e.extensions?.code === 'THROTTLED')) return null;
    const cost = parsed?.extensions?.cost;
    if (!cost || cost.throttleStatus.restoreRate <= 0) return FALLBACK_RETRY_MS;
    const missing = cost.requestedQueryCost - cost.throttleStatus.currentlyAvailable;
    return Math.max(MIN_THROTTLE_MS, Math.ceil((missing / cost.throttleStatus.restoreRate) * 1000));
  },
};

export function toGid(type: GidType, id: string): string {
  return id.startsWith('gid://') ? id : `gid://shopify/${type}/${id}`;
}

export function fromGid(gid: string): string {
  const path = gid.split('?')[0] ?? gid;
  return path.slice(path.lastIndexOf('/') + 1);
}

function describeUserErrors(errors: UserError[]): string {
  return errors.map((e) => (e.field?.length ? `${e.field.join('.')}: ${e.message}` : e.message)).join('; ');
}

export class ShopifyConnector implements StoreConnector {
  readonly provider = 'shopify' as const;

  constructor(private readonly ctx: ConnectorContext) {
    const { accessToken } = ctx.credentials;
    if (!accessToken) throw new Error('Shopify needs an accessToken');
    ctx.http.setHeader('x-shopify-access-token', accessToken);
  }

  verifyWebhook(webhook: IncomingWebhook, secret: string): boolean {
    return safeEqual(webhook.headers['x-shopify-hmac-sha256'], hmacSha256(secret, webhook.rawBody));
  }

  parseWebhook(webhook: IncomingWebhook): WebhookEvent[] {
    const deliveryId = webhook.headers['x-shopify-webhook-id'];
    const topic = TOPICS[webhook.headers['x-shopify-topic'] ?? ''];
    if (!deliveryId || !topic) return [];
    const body = JSON.parse(webhook.rawBody.toString('utf8')) as ShopifyWebhookBody;
    return [{ topic, deliveryId, entityId: body.id ? String(body.id) : null }];
  }

  async getOrder(externalId: string): Promise<StoreOrder> {
    const { order } = await this.gql<OrderQuery>(ORDER_QUERY, { id: toGid('Order', externalId) });
    if (!order) throw new NotFoundError('shopify', `order ${externalId}`);
    return this.toOrder(order);
  }

  async listOrdersUpdatedSince(since: Date, limit: number): Promise<StoreOrder[]> {
    const { orders } = await this.gql<OrderIdsQuery>(ORDER_IDS_QUERY, {
      first: Math.min(limit, ORDERS_PAGE),
      query: `updated_at:>'${since.toISOString()}'`,
    });
    const out: StoreOrder[] = [];
    for (const { id } of orders.nodes) out.push(await this.getOrder(id));
    return out;
  }

  async listProducts(): Promise<StoreProduct[]> {
    const out: StoreProduct[] = [];
    let after: string | null = null;
    do {
      const { productVariants }: VariantsQuery = await this.gql<VariantsQuery>(VARIANTS_QUERY, {
        first: VARIANTS_PAGE,
        after,
      });
      out.push(...productVariants.nodes.map((v) => this.toProduct(v)));
      after = productVariants.pageInfo.hasNextPage ? productVariants.pageInfo.endCursor : null;
    } while (after);
    return out;
  }

  async updateStock(updates: Array<{ ref: StoreProductRef; quantity: number }>): Promise<BatchResult> {
    const result: BatchResult = { updated: 0, failed: [] };
    const ready = updates.filter(({ ref }) => {
      if (ref.inventoryItemId) return true;
      result.failed.push({ ref, reason: 'No Shopify inventory item id, refresh the product list' });
      return false;
    });
    for (let i = 0; i < ready.length; i += INPUT_LIMIT) {
      const chunk = ready.slice(i, i + INPUT_LIMIT);
      const error = await this.setQuantities(
        chunk.map(({ ref, quantity }) => ({ inventoryItemId: ref.inventoryItemId ?? '', quantity })),
      );
      // the mutation is applied all-or-nothing, so one error fails the whole chunk
      if (error) result.failed.push(...chunk.map(({ ref }) => ({ ref, reason: error })));
      else result.updated += chunk.length;
    }
    return result;
  }

  async updatePrices(updates: Array<{ ref: StoreProductRef; priceMinor: number }>): Promise<BatchResult> {
    const result: BatchResult = { updated: 0, failed: [] };
    const byProduct = new Map<string, typeof updates>();
    for (const update of updates) {
      if (!update.ref.variantId) {
        result.failed.push({ ref: update.ref, reason: 'No Shopify variant id' });
        continue;
      }
      byProduct.set(update.ref.productId, [...(byProduct.get(update.ref.productId) ?? []), update]);
    }
    for (const [productId, group] of byProduct) {
      for (let i = 0; i < group.length; i += INPUT_LIMIT) {
        const chunk = group.slice(i, i + INPUT_LIMIT);
        const { productVariantsBulkUpdate } = await this.gql<VariantsBulkUpdateMutation>(
          VARIANTS_BULK_UPDATE_MUTATION,
          {
            productId: toGid('Product', productId),
            variants: chunk.map(({ ref, priceMinor }) => ({
              id: toGid('ProductVariant', ref.variantId ?? ''),
              price: fromMinor(priceMinor, this.currency),
            })),
          },
        );
        const reasons = this.reasonsByIndex(productVariantsBulkUpdate.userErrors, chunk.length);
        for (const [idx, { ref }] of chunk.entries()) {
          const reason = reasons.get(idx);
          if (reason) result.failed.push({ ref, reason });
          else result.updated += 1;
        }
      }
    }
    return result;
  }

  async createProduct(product: NewStoreProduct): Promise<StoreProductRef> {
    const { productCreate } = await this.gql<ProductCreateMutation>(PRODUCT_CREATE_MUTATION, {
      product: {
        title: product.name,
        descriptionHtml: product.description ?? '',
        // new items land as drafts so a manager can add photos before they go live
        status: 'DRAFT',
      },
    });
    this.assertNoUserErrors(productCreate.userErrors);
    const variant = productCreate.product?.variants.nodes[0];
    if (!productCreate.product || !variant) {
      throw new ValidationRejectedError('shopify', 'productCreate returned no default variant');
    }
    const productId = productCreate.product.id;

    // productCreate only takes product-level fields; sku, barcode and price live on the variant
    const { productVariantsBulkUpdate } = await this.gql<VariantsBulkUpdateMutation>(
      VARIANTS_BULK_UPDATE_MUTATION,
      {
        productId,
        variants: [
          {
            id: variant.id,
            price: fromMinor(product.priceMinor, this.currency),
            barcodes: product.barcode ? [{ value: product.barcode }] : undefined,
            inventoryItem: { sku: product.sku, tracked: true },
          },
        ],
      },
    );
    this.assertNoUserErrors(productVariantsBulkUpdate.userErrors);

    const inventoryItemId = fromGid(variant.inventoryItem.id);
    if (this.locationId) {
      const error = await this.setQuantities([{ inventoryItemId, quantity: product.stock }]);
      if (error) throw new ValidationRejectedError('shopify', error);
    }
    return { productId: fromGid(productId), variantId: fromGid(variant.id), inventoryItemId };
  }

  private get currency(): string {
    return String(this.ctx.settings.currency ?? 'USD');
  }

  private get locationId(): string | null {
    const id = this.ctx.settings.locationId;
    return typeof id === 'string' && id ? toGid('Location', id) : null;
  }

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const { data } = await this.ctx.http.post<GqlResponse<T>>(this.ctx.baseUrl, {
      absolute: true,
      json: { query, variables },
    });
    const errors = errorList(data);
    if (errors.length) throw new ValidationRejectedError('shopify', errors.map((e) => e.message).join('; '));
    if (!data.data) throw new ValidationRejectedError('shopify', 'empty GraphQL response');
    return data.data;
  }

  private assertNoUserErrors(errors: UserError[]): void {
    if (errors.length) throw new ValidationRejectedError('shopify', describeUserErrors(errors));
  }

  /** returns a combined error message, or null when every quantity was set */
  private async setQuantities(items: Array<{ inventoryItemId: string; quantity: number }>) {
    const locationId = this.locationId;
    if (!locationId) return 'Shopify location is not configured for this connection';
    const quantities = items.map(({ inventoryItemId, quantity }) => ({
      inventoryItemId: toGid('InventoryItem', inventoryItemId),
      locationId,
      quantity,
      // null skips the compare-and-swap check: the accounting system is the source of truth
      changeFromQuantity: null,
    }));
    // same content -> same key, so a retried job is deduplicated by Shopify
    // the operation attempt is part of the key: pushing the same level again later is a new request,
    // while a resend inside one attempt is collapsed by Shopify
    const run = currentJournalScope();
    const key = createHash('sha256')
      .update(JSON.stringify({ run: run ? `${run.operationId}:${run.attempt}` : null, quantities }))
      .digest('hex');
    const { inventorySetQuantities } = await this.gql<InventorySetMutation>(INVENTORY_SET_MUTATION, {
      idempotencyKey: key,
      input: {
        name: 'available',
        reason: 'correction',
        referenceDocumentUri: `gid://shop-accounting-sync/StockSync/${key}`,
        quantities,
      },
    });
    const errors = inventorySetQuantities.userErrors;
    return errors.length ? describeUserErrors(errors) : null;
  }

  /** userErrors point at inputs via field paths like ["variants", "2", "price"] */
  private reasonsByIndex(errors: UserError[], size: number): Map<number, string> {
    const reasons = new Map<number, string>();
    for (const error of errors) {
      const index = Number(error.field?.[1]);
      const targets = Number.isInteger(index) ? [index] : [...Array(size).keys()];
      for (const idx of targets) {
        const prev = reasons.get(idx);
        reasons.set(idx, prev ? `${prev}; ${error.message}` : error.message);
      }
    }
    return reasons;
  }

  private toProduct(v: GqlVariant): StoreProduct {
    return {
      productId: fromGid(v.product.id),
      variantId: fromGid(v.id),
      inventoryItemId: fromGid(v.inventoryItem.id),
      sku: v.sku ?? '',
      barcode: v.barcodes.nodes[0]?.value ?? null,
      name: v.title === 'Default Title' ? v.product.title : `${v.product.title} (${v.title})`,
      priceMinor: toMinor(v.price, this.currency),
      stock: v.inventoryItem.tracked ? (v.inventoryQuantity ?? 0) : null,
    };
  }

  private toOrder(o: GqlOrder): StoreOrder {
    const cur = o.currencyCode;
    const lines = o.lineItems.nodes.map((li) => toLine(li, cur, o.taxesIncluded));
    const payment = o.transactions.find(
      (t) => t.status === 'SUCCESS' && PAYMENT_KINDS.has(t.kind) && t.processedAt,
    );
    const address = o.shippingAddress ?? o.billingAddress;
    const contact = o.billingAddress ?? o.shippingAddress;
    return {
      externalId: fromGid(o.id),
      number: o.name.replace(/^#/, ''),
      status: (o.displayFinancialStatus ?? 'pending').toLowerCase(),
      currency: cur,
      createdAt: new Date(o.createdAt),
      updatedAt: new Date(o.updatedAt),
      customer: {
        externalId: o.customer ? fromGid(o.customer.id) : null,
        email: o.email ?? o.customer?.defaultEmailAddress?.emailAddress ?? null,
        phone: o.phone ?? o.customer?.defaultPhoneNumber?.phoneNumber ?? contact?.phone ?? null,
        firstName: o.customer?.firstName ?? contact?.firstName ?? '',
        lastName: o.customer?.lastName ?? contact?.lastName ?? '',
        company: contact?.company || null,
        address: address ? toAddress(address) : null,
      },
      lines,
      shipping: toShipping(
        o.shippingLines.nodes.filter((s) => !s.isRemoved),
        cur,
        o.taxesIncluded,
      ),
      discountTotalMinor: lines.reduce((sum, l) => sum + l.discountMinor, 0),
      taxTotalMinor: o.totalTaxSet ? amount(o.totalTaxSet, cur) : 0,
      totalMinor: amount(o.totalPriceSet, cur),
      payment: {
        paid: payment !== undefined || PAID_STATUSES.has(o.displayFinancialStatus ?? ''),
        paidAt: payment?.processedAt ? new Date(payment.processedAt) : null,
        method: payment?.gateway ?? o.transactions[0]?.gateway ?? null,
        transactionId: payment ? fromGid(payment.id) : null,
      },
      note: o.note || null,
      adminUrl: this.adminUrl(fromGid(o.id)),
    };
  }

  private adminUrl(orderId: string): string | null {
    const domain = this.ctx.settings.shopDomain;
    if (typeof domain !== 'string' || !domain) return null;
    const handle = domain.replace(/^https?:\/\//, '').replace(/\.myshopify\.com\/?$/, '');
    return `https://admin.shopify.com/store/${handle}/orders/${orderId}`;
  }
}

function amount(bag: MoneyBag, currency: string): number {
  return toMinor(bag.shopMoney.amount, currency);
}

function taxOf(
  taxLines: GqlTaxLine[],
  currency: string,
): { taxMinor: number; taxRatePercent: number | null } {
  const applied = taxLines.find((t) => Number(t.priceSet.shopMoney.amount) !== 0) ?? taxLines[0];
  return {
    taxMinor: taxLines.reduce((sum, t) => sum + amount(t.priceSet, currency), 0),
    taxRatePercent: applied?.ratePercentage ?? null,
  };
}

/** share of a tax-inclusive amount that is not tax; falls back to the rate when the amount is zero */
function netShare(gross: number, tax: number, ratePercent: number | null): number {
  return gross > 0 ? (gross - tax) / gross : 1 / (1 + (ratePercent ?? 0) / 100);
}

function toLine(li: GqlLineItem, cur: string, taxesIncluded: boolean): OrderLine {
  const unit = amount(li.originalUnitPriceSet, cur);
  // allocations include order-level discount codes, totalDiscountSet does not
  const discount = li.discountAllocations.reduce((sum, d) => sum + amount(d.allocatedAmountSet, cur), 0);
  const gross = amount(li.originalTotalSet, cur) - discount;
  const { taxMinor, taxRatePercent } = taxOf(li.taxLines, cur);
  const base = {
    externalId: fromGid(li.id),
    productExternalId: li.product ? fromGid(li.product.id) : '',
    variantExternalId: li.variant ? fromGid(li.variant.id) : null,
    sku: li.sku || null,
    name: li.name,
    quantity: li.quantity,
    taxRatePercent,
    taxMinor,
  };
  if (!taxesIncluded) return { ...base, unitPriceMinor: unit, discountMinor: discount, totalMinor: gross };

  // the domain is tax-exclusive; derive the discount last so unit * qty - discount = total holds exactly
  const total = gross - taxMinor;
  const unitNet = Math.round(unit * netShare(gross, taxMinor, taxRatePercent));
  return {
    ...base,
    unitPriceMinor: unitNet,
    discountMinor: unitNet * li.quantity - total,
    totalMinor: total,
  };
}

function toShipping(lines: GqlShippingLine[], cur: string, taxesIncluded: boolean): Shipping | null {
  const first = lines[0];
  if (!first) return null;
  let price = 0;
  let tax = 0;
  for (const line of lines) {
    const lineTax = taxOf(line.taxLines, cur).taxMinor;
    price += amount(line.discountedPriceSet, cur) - (taxesIncluded ? lineTax : 0);
    tax += lineTax;
  }
  return {
    title: first.title,
    priceMinor: price,
    taxMinor: tax,
    taxRatePercent: taxOf(first.taxLines, cur).taxRatePercent,
  };
}

function toAddress(a: GqlAddress): Address {
  return {
    line1: a.address1 || null,
    line2: a.address2 || null,
    city: a.city || null,
    postcode: a.zip || null,
    region: a.province || null,
    country: a.countryCodeV2 || null,
  };
}

export const shopifyFactory: StoreConnectorFactory = {
  provider: 'shopify',
  kind: 'store',
  create: (ctx) => new ShopifyConnector(ctx),
};
