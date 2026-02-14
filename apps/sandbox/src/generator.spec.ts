import { createHmac } from 'node:crypto';
import { DEMO_IDS } from '@sas/demo-data';
import { describe, expect, it } from 'vitest';
import { MOYSKLAD } from './ids.js';
import { OrderFactory } from './orders.js';
import { seededRandom } from './random.js';
import { ActivityLog } from './state/sandbox.js';
import { harness, TEST_TOKEN } from './testing/harness.js';
import { WebhookSender, wooOrderWebhook } from './webhooks.js';

interface Captured {
  url: string;
  headers: Headers;
  body: string;
}

function recorder(statuses: number[] = []) {
  const calls: Captured[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push({ url: request.url, headers: request.headers, body: await request.text() });
    return new Response('{}', { status: statuses.shift() ?? 200 });
  };
  return { calls, fetchImpl };
}

describe('webhook delivery', () => {
  it('retries a failed delivery twice with the same delivery id, then gives up', async () => {
    const { calls, fetchImpl } = recorder([500, 502, 503]);
    const log = new ActivityLog();
    const sender = new WebhookSender({ target: 'http://api.test', log, retryDelaysMs: [0, 0], fetchImpl });
    const h = harness();
    const { order } = new OrderFactory(h.sandbox.state, seededRandom(4)).createZernoOrder();

    const outcome = await sender.send(wooOrderWebhook(TEST_TOKEN, order, 'created'));
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toBe(`http://api.test/webhooks/${DEMO_IDS.zerno.store}`);
    expect(new Set(calls.map((c) => c.headers.get('x-wc-webhook-delivery-id'))).size).toBe(1);
    const signature = createHmac('sha256', TEST_TOKEN)
      .update(calls[0]?.body ?? '')
      .digest('base64');
    expect(calls[0]?.headers.get('x-wc-webhook-signature')).toBe(signature);
    expect(outcome).toBe('503 after 3 attempts');
    expect(log.webhooks[0]?.outcome).toBe(outcome);
  });

  it('stops retrying after the first 2xx', async () => {
    const { calls, fetchImpl } = recorder([500, 200]);
    const sender = new WebhookSender({
      target: 'http://api.test',
      log: new ActivityLog(),
      retryDelaysMs: [0, 0],
      fetchImpl,
    });
    const h = harness();
    const { order } = new OrderFactory(h.sandbox.state, seededRandom(4)).createZernoOrder();
    expect(await sender.send(wooOrderWebhook(TEST_TOKEN, order, 'updated'))).toBe('200 after 2 attempts');
    expect(calls).toHaveLength(2);
  });
});

describe('generator', () => {
  it('places orders in both shops and announces them', async () => {
    const { calls, fetchImpl } = recorder();
    const h = harness({}, { fetchImpl, random: seededRandom(9) });
    for (let i = 0; i < 30; i++) await h.sandbox.generator.placeOrder();

    const { woo, shopify, activity } = h.sandbox.state;
    expect(woo.orders.size + shopify.orders.size).toBe(30);
    expect(woo.orders.size).toBeGreaterThan(0);
    expect(shopify.orders.size).toBeGreaterThan(0);
    expect(activity.orders).toHaveLength(30);
    const topics = calls.map((c) => c.headers.get('x-wc-webhook-topic') ?? c.headers.get('x-shopify-topic'));
    expect(topics.every((t) => t === 'order.created' || t === 'orders/create')).toBe(true);
    expect(calls.length).toBeGreaterThan(20);
  });

  it('moves stock in МойСклад and sends a webhookstock call', async () => {
    const { calls, fetchImpl } = recorder();
    const h = harness({}, { fetchImpl, random: seededRandom(12) });
    const ms = h.sandbox.state.moysklad;
    const before = new Map([...ms.products.values()].map((p) => [p.id, p.stock.get(MOYSKLAD.mainStoreId)]));
    await h.sandbox.generator.changeStock();

    const changed = [...ms.products.values()].filter(
      (p) => p.stock.get(MOYSKLAD.mainStoreId) !== before.get(p.id),
    );
    expect(changed.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe(`/webhooks/${DEMO_IDS.zerno.accounting}`);
    expect(url.searchParams.get('secret')).toBe(TEST_TOKEN);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toMatchObject({ stockType: 'stock', reportType: 'all' });
  });

  it('alternates price changes between МойСклад and Xero', async () => {
    const { calls, fetchImpl } = recorder();
    const h = harness({}, { fetchImpl, random: seededRandom(21) });
    const msPrices = [...h.sandbox.state.moysklad.products.values()].map((p) => p.priceMinor);
    const xeroPrices = [...h.sandbox.state.xero.items.values()].map((i) => i.priceMinor);
    await h.sandbox.generator.changePrice();
    await h.sandbox.generator.changePrice();

    expect([...h.sandbox.state.moysklad.products.values()].map((p) => p.priceMinor)).not.toEqual(msPrices);
    expect([...h.sandbox.state.xero.items.values()].map((i) => i.priceMinor)).not.toEqual(xeroPrices);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]?.body ?? '{}').events[0]).toMatchObject({
      action: 'UPDATE',
      updatedFields: ['salePrices'],
    });
  });
});
