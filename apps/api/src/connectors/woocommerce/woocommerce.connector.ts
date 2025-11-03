import type { ConnectorContext, StoreConnector, StoreConnectorFactory } from '../../domain/connectors.js';
import type {
  Address,
  BatchResult,
  IncomingWebhook,
  NewStoreProduct,
  OrderLine,
  StoreOrder,
  StoreProduct,
  StoreProductRef,
  WebhookEvent,
  WebhookTopic,
} from '../../domain/models.js';
import { fromMinor, toMinor } from '../../domain/money.js';
import { hmacSha256, safeEqual } from '../../security/hmac.js';
import { type ErrorPolicy, parseRetryAfter } from '../http/http-client.js';
import type {
  WcAddress,
  WcBatchResponse,
  WcError,
  WcOrder,
  WcProduct,
  WcVariation,
} from './woocommerce.types.js';

const PAGE_SIZE = 100;
const BATCH_LIMIT = 100;
const MAX_PAGES = 500;
const PAID_STATUSES = new Set(['processing', 'completed']);

export const wooErrorPolicy: ErrorPolicy = {
  retryAfterMs: (headers) => parseRetryAfter(headers.get('retry-after'), 10_000),
  extractMessage: (body) => {
    try {
      const err = JSON.parse(body) as WcError;
      return err.message ? `${err.message} (${err.code})` : null;
    } catch {
      return null;
    }
  },
};

const TOPICS: Record<string, WebhookTopic> = {
  'order.created': 'order.created',
  'order.updated': 'order.updated',
  'product.created': 'product.created',
  'product.updated': 'product.updated',
};

export class WooCommerceConnector implements StoreConnector {
  readonly provider = 'woocommerce' as const;

  constructor(private readonly ctx: ConnectorContext) {
    const { consumerKey, consumerSecret } = ctx.credentials;
    if (!consumerKey || !consumerSecret) throw new Error('WooCommerce needs consumerKey and consumerSecret');
    const basic = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    ctx.http.setHeader('authorization', `Basic ${basic}`);
  }

  verifyWebhook(webhook: IncomingWebhook, secret: string): boolean {
    return safeEqual(webhook.headers['x-wc-webhook-signature'], hmacSha256(secret, webhook.rawBody));
  }

  parseWebhook(webhook: IncomingWebhook): WebhookEvent[] {
    const deliveryId = webhook.headers['x-wc-webhook-delivery-id'];
    const topic = webhook.headers['x-wc-webhook-topic'] ?? '';
    // WooCommerce pings a new webhook with a form body "webhook_id=N" and no topic
    if (!topic || !deliveryId) return [{ topic: 'ping', deliveryId: deliveryId ?? 'ping', entityId: null }];
    const mapped = TOPICS[topic];
    if (!mapped) return [];
    const body = JSON.parse(webhook.rawBody.toString('utf8')) as { id?: number };
    return [{ topic: mapped, deliveryId, entityId: body.id ? String(body.id) : null }];
  }

  async getOrder(externalId: string): Promise<StoreOrder> {
    const { data } = await this.ctx.http.get<WcOrder>(`/orders/${encodeURIComponent(externalId)}`);
    return this.toOrder(data);
  }

  async listOrdersUpdatedSince(since: Date, limit: number): Promise<StoreOrder[]> {
    const { data } = await this.ctx.http.get<WcOrder[]>('/orders', {
      query: {
        modified_after: since.toISOString(),
        dates_are_gmt: true,
        orderby: 'modified',
        order: 'asc',
        per_page: Math.min(limit, PAGE_SIZE),
      },
    });
    return data.map((o) => this.toOrder(o));
  }

  async listProducts(): Promise<StoreProduct[]> {
    const products = await this.paginate<WcProduct>('/products', { status: 'any' });
    const out: StoreProduct[] = [];
    for (const p of products) {
      if (p.type === 'variable') {
        const variations = await this.paginate<WcVariation>(`/products/${p.id}/variations`);
        for (const v of variations) out.push(this.fromVariation(p, v));
      } else if (p.type === 'simple') {
        out.push({
          productId: String(p.id),
          variantId: null,
          sku: p.sku,
          barcode: p.global_unique_id || null,
          name: p.name,
          priceMinor: toMinor(p.regular_price || p.price, this.currency),
          stock: p.manage_stock ? (p.stock_quantity ?? 0) : null,
        });
      }
    }
    return out;
  }

  updateStock(updates: Array<{ ref: StoreProductRef; quantity: number }>): Promise<BatchResult> {
    return this.batchUpdate(
      updates.map(({ ref, quantity }) => ({
        ref,
        body: { manage_stock: true, stock_quantity: quantity },
      })),
    );
  }

  updatePrices(updates: Array<{ ref: StoreProductRef; priceMinor: number }>): Promise<BatchResult> {
    return this.batchUpdate(
      updates.map(({ ref, priceMinor }) => ({
        ref,
        body: { regular_price: fromMinor(priceMinor, this.currency) },
      })),
    );
  }

  async createProduct(product: NewStoreProduct): Promise<StoreProductRef> {
    const { data } = await this.ctx.http.post<WcProduct>('/products', {
      json: {
        name: product.name,
        type: 'simple',
        // new items land as drafts so a manager can add photos before they go live
        status: 'draft',
        sku: product.sku,
        global_unique_id: product.barcode ?? undefined,
        regular_price: fromMinor(product.priceMinor, this.currency),
        description: product.description ?? '',
        manage_stock: true,
        stock_quantity: product.stock,
      },
    });
    return { productId: String(data.id), variantId: null };
  }

  private get currency(): string {
    return String(this.ctx.settings.currency ?? 'USD');
  }

  private async batchUpdate(
    items: Array<{ ref: StoreProductRef; body: Record<string, unknown> }>,
  ): Promise<BatchResult> {
    const result: BatchResult = { updated: 0, failed: [] };
    // simple products go to /products/batch, variations to their parent's batch endpoint
    const groups = new Map<string, typeof items>();
    for (const item of items) {
      const key = item.ref.variantId ? `/products/${item.ref.productId}/variations/batch` : '/products/batch';
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    for (const [path, group] of groups) {
      for (let i = 0; i < group.length; i += BATCH_LIMIT) {
        const chunk = group.slice(i, i + BATCH_LIMIT);
        const { data } = await this.ctx.http.post<WcBatchResponse>(path, {
          json: {
            update: chunk.map(({ ref, body }) => ({ id: Number(ref.variantId ?? ref.productId), ...body })),
          },
        });
        for (const [idx, row] of (data.update ?? []).entries()) {
          const ref = chunk[idx]?.ref;
          if (!ref) continue;
          if (row.error) result.failed.push({ ref, reason: row.error.message });
          else result.updated += 1;
        }
      }
    }
    return result;
  }

  private async paginate<T>(path: string, query: Record<string, string> = {}): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const { data, headers } = await this.ctx.http.get<T[]>(path, {
        query: { ...query, per_page: PAGE_SIZE, page },
      });
      out.push(...data);
      const header = Number.parseInt(headers.get('x-wp-totalpages') ?? '', 10);
      const totalPages = Number.isFinite(header) && header > 0 ? header : null;
      const done = data.length === 0 || (totalPages === null ? data.length < PAGE_SIZE : page >= totalPages);
      if (done) return out;
      if (page >= MAX_PAGES) throw new Error(`${path}: more than ${MAX_PAGES} pages, refusing to continue`);
    }
  }

  private fromVariation(parent: WcProduct, v: WcVariation): StoreProduct {
    const options = v.attributes.map((a) => a.option).join(' / ');
    return {
      productId: String(parent.id),
      variantId: String(v.id),
      sku: v.sku,
      barcode: v.global_unique_id || null,
      name: options ? `${parent.name} (${options})` : parent.name,
      priceMinor: toMinor(v.regular_price || v.price, this.currency),
      stock: v.manage_stock === true ? (v.stock_quantity ?? 0) : null,
    };
  }

  private toOrder(o: WcOrder): StoreOrder {
    const cur = o.currency;
    const rates = new Map(o.tax_lines.map((t) => [t.rate_id, t.rate_percent]));
    const rateOf = (taxes: { id: number; total: string }[]) => {
      const applied = taxes.find((t) => Number(t.total) !== 0) ?? taxes[0];
      return applied ? (rates.get(applied.id) ?? null) : null;
    };

    const lines: OrderLine[] = o.line_items.map((li) => {
      const subtotal = toMinor(li.subtotal, cur);
      const total = toMinor(li.total, cur);
      return {
        externalId: String(li.id),
        productExternalId: String(li.product_id),
        variantExternalId: li.variation_id ? String(li.variation_id) : null,
        sku: li.sku || null,
        name: li.name,
        quantity: li.quantity,
        unitPriceMinor: li.quantity ? Math.round(subtotal / li.quantity) : subtotal,
        discountMinor: subtotal - total,
        taxRatePercent: rateOf(li.taxes),
        taxMinor: toMinor(li.total_tax, cur),
        totalMinor: total,
      };
    });

    const ship = o.shipping_lines[0];
    const paidAt = o.date_paid_gmt ? new Date(`${o.date_paid_gmt}Z`) : null;
    return {
      externalId: String(o.id),
      number: o.number,
      status: o.status,
      currency: cur,
      createdAt: new Date(`${o.date_created_gmt}Z`),
      updatedAt: new Date(`${o.date_modified_gmt}Z`),
      customer: {
        externalId: o.customer_id ? String(o.customer_id) : null,
        email: o.billing.email || null,
        phone: o.billing.phone || null,
        firstName: o.billing.first_name,
        lastName: o.billing.last_name,
        company: o.billing.company || null,
        address: toAddress(o.shipping.address_1 ? o.shipping : o.billing),
      },
      lines,
      shipping: ship
        ? {
            title: ship.method_title,
            priceMinor: o.shipping_lines.reduce((sum, s) => sum + toMinor(s.total, cur), 0),
            taxMinor: o.shipping_lines.reduce((sum, s) => sum + toMinor(s.total_tax, cur), 0),
            taxRatePercent: rateOf(ship.taxes),
          }
        : null,
      discountTotalMinor: toMinor(o.discount_total, cur),
      taxTotalMinor: toMinor(o.total_tax, cur),
      totalMinor: toMinor(o.total, cur),
      payment: {
        paid: paidAt !== null || PAID_STATUSES.has(o.status),
        paidAt,
        method: o.payment_method_title || o.payment_method || null,
        transactionId: o.transaction_id || null,
      },
      note: o.customer_note || null,
      adminUrl: this.adminUrl(o.id),
    };
  }

  private adminUrl(orderId: number): string | null {
    const site = this.ctx.settings.siteUrl;
    return typeof site === 'string'
      ? `${site.replace(/\/$/, '')}/wp-admin/post.php?post=${orderId}&action=edit`
      : null;
  }
}

function toAddress(a: WcAddress): Address {
  return {
    line1: a.address_1 || null,
    line2: a.address_2 || null,
    city: a.city || null,
    postcode: a.postcode || null,
    region: a.state || null,
    country: a.country || null,
  };
}

export const wooCommerceFactory: StoreConnectorFactory = {
  provider: 'woocommerce',
  kind: 'store',
  create: (ctx) => new WooCommerceConnector(ctx),
};
