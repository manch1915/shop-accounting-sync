import { createHmac, randomUUID } from 'node:crypto';
import { DEMO_IDS, SANDBOX_PATHS } from '@sas/demo-data';
import { MOYSKLAD, SHOPIFY, WOOCOMMERCE } from './ids.js';
import { localTime } from './state/clock.js';
import type { ActivityLog } from './state/sandbox.js';
import type { ShopifyOrder } from './state/shopify.js';
import type { WooOrder } from './state/woocommerce.js';

export interface Delivery {
  connectionId: string;
  topic: string;
  deliveryId: string;
  headers: Record<string, string>;
  query?: Record<string, string>;
  body: string;
}

export interface WebhookSenderOptions {
  target: string;
  log: ActivityLog;
  /** delays before the 2nd and 3rd attempt; real providers retry too, just much slower */
  retryDelaysMs?: number[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const sign = (secret: string, body: string): string =>
  createHmac('sha256', secret).update(body).digest('base64');

export class WebhookSender {
  private readonly retryDelaysMs: number[];
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: WebhookSenderOptions) {
    this.retryDelaysMs = opts.retryDelaysMs ?? [2_000, 5_000];
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** delivers with retries and returns a short outcome for the status page */
  async send(delivery: Delivery): Promise<string> {
    const url = new URL(`${this.opts.target}/webhooks/${delivery.connectionId}`);
    for (const [key, value] of Object.entries(delivery.query ?? {})) url.searchParams.set(key, value);
    let outcome = '';
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      if (attempt > 0) await sleep(this.retryDelaysMs[attempt - 1] ?? 0);
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...delivery.headers },
          body: delivery.body,
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5_000),
        });
        await res.arrayBuffer().catch(() => undefined);
        outcome = `${res.status}${attempt ? ` after ${attempt + 1} attempts` : ''}`;
        if (res.ok) break;
      } catch (err) {
        outcome = `${err instanceof Error ? err.message : String(err)}${attempt ? ` after ${attempt + 1} attempts` : ''}`;
      }
    }
    this.opts.log.addWebhook({
      at: new Date(),
      connectionId: delivery.connectionId,
      topic: delivery.topic,
      deliveryId: delivery.deliveryId,
      outcome,
    });
    console.log(`webhook ${delivery.topic} -> ${delivery.connectionId} [${delivery.deliveryId}]: ${outcome}`);
    return outcome;
  }
}

export function wooOrderWebhook(
  secret: string,
  order: WooOrder,
  event: 'created' | 'updated',
  deliveryId: string = randomUUID(),
): Delivery {
  const body = JSON.stringify(order.json);
  return {
    connectionId: DEMO_IDS.zerno.store,
    topic: `order.${event}`,
    deliveryId,
    body,
    headers: {
      'user-agent': 'WooCommerce/9.8.2 Hookshot (WordPress/6.8.3)',
      'x-wc-webhook-source': `${WOOCOMMERCE.siteUrl}/`,
      'x-wc-webhook-topic': `order.${event}`,
      'x-wc-webhook-resource': 'order',
      'x-wc-webhook-event': event,
      'x-wc-webhook-signature': sign(secret, body),
      'x-wc-webhook-id': String(WOOCOMMERCE.webhookId + (event === 'created' ? 0 : 1)),
      'x-wc-webhook-delivery-id': deliveryId,
    },
  };
}

export function shopifyOrderWebhook(
  secret: string,
  order: ShopifyOrder,
  topic: 'orders/create' | 'orders/paid' | 'orders/updated',
  webhookId: string = randomUUID(),
): Delivery {
  const body = JSON.stringify(shopifyRestOrder(order));
  return {
    connectionId: DEMO_IDS.hillside.store,
    topic,
    deliveryId: webhookId,
    body,
    headers: {
      'user-agent': 'Shopify-Captain-Hook',
      'x-shopify-topic': topic,
      'x-shopify-hmac-sha256': sign(secret, body),
      'x-shopify-shop-domain': SHOPIFY.shopDomain,
      'x-shopify-api-version': SHOPIFY.apiVersion,
      'x-shopify-webhook-id': webhookId,
      'x-shopify-event-id': randomUUID(),
      'x-shopify-triggered-at': new Date().toISOString(),
    },
  };
}

export function moyskladStockWebhook(secret: string, publicUrl: string, changedSince: Date): Delivery {
  const requestId = randomUUID();
  const base = `${publicUrl}${SANDBOX_PATHS.moysklad}`;
  const body = JSON.stringify({
    accountId: MOYSKLAD.accountId,
    stockType: 'stock',
    reportType: 'all',
    reportUrl: `${base}/report/stock/all/current?changedSince=${localTime(changedSince, 'Europe/Moscow')}`,
  });
  return {
    connectionId: DEMO_IDS.zerno.accounting,
    topic: 'webhookstock',
    deliveryId: requestId,
    query: { secret, requestId },
    headers: { 'user-agent': 'MoySklad-Webhook' },
    body,
  };
}

export function moyskladProductWebhook(secret: string, publicUrl: string, productIds: string[]): Delivery {
  const requestId = randomUUID();
  const base = `${publicUrl}${SANDBOX_PATHS.moysklad}`;
  const body = JSON.stringify({
    auditContext: {
      meta: { type: 'audit', href: `${base}/audit/${randomUUID()}` },
      uid: 'admin@zerno-i-par',
      moment: localTime(new Date(), 'Europe/Moscow'),
    },
    events: productIds.map((id) => ({
      meta: { type: 'product', href: `${base}/entity/product/${id}` },
      action: 'UPDATE',
      accountId: MOYSKLAD.accountId,
      updatedFields: ['salePrices'],
    })),
  });
  return {
    connectionId: DEMO_IDS.zerno.accounting,
    topic: 'product.UPDATE',
    deliveryId: requestId,
    query: { secret, requestId },
    headers: { 'user-agent': 'MoySklad-Webhook' },
    body,
  };
}

/** the REST-style order JSON Shopify still sends in webhook bodies */
export function shopifyRestOrder(order: ShopifyOrder) {
  const g = order.gql;
  const tail = (id: string) => Number(id.slice(id.lastIndexOf('/') + 1));
  return {
    id: order.id,
    admin_graphql_api_id: g.id,
    name: g.name,
    order_number: order.number,
    email: g.email,
    created_at: g.createdAt,
    updated_at: g.updatedAt,
    currency: g.currencyCode,
    presentment_currency: g.currencyCode,
    financial_status: g.displayFinancialStatus.toLowerCase(),
    fulfillment_status: null,
    taxes_included: g.taxesIncluded,
    subtotal_price: g.subtotalPriceSet.shopMoney.amount,
    total_discounts: g.totalDiscountsSet.shopMoney.amount,
    total_tax: g.totalTaxSet.shopMoney.amount,
    total_price: g.totalPriceSet.shopMoney.amount,
    discount_codes: g.discountCodes.map((code) => ({ code, type: 'percentage' })),
    customer: g.customer
      ? { id: tail(g.customer.id), first_name: g.customer.firstName, last_name: g.customer.lastName }
      : null,
    line_items: g.lineItems.nodes.map((li) => ({
      id: tail(li.id),
      variant_id: tail(li.variant.id),
      product_id: tail(li.product.id),
      sku: li.sku,
      name: li.name,
      quantity: li.quantity,
      price: li.originalUnitPriceSet.shopMoney.amount,
    })),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
