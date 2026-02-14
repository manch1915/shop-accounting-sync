import { ZERNO_PRODUCTS } from '@sas/demo-data';
import { describe, expect, it } from 'vitest';
import { AuthError, NotFoundError } from '../../../api/src/domain/errors.js';
import type { StoreOrder } from '../../../api/src/domain/models.js';
import { OrderFactory } from '../orders.js';
import { seededRandom } from '../random.js';
import { harness, TEST_TOKEN } from '../testing/harness.js';
import { wooOrderWebhook } from '../webhooks.js';

function assertConsistent(order: StoreOrder): void {
  const lines = order.lines.reduce((sum, l) => sum + l.totalMinor + l.taxMinor, 0);
  const shipping = (order.shipping?.priceMinor ?? 0) + (order.shipping?.taxMinor ?? 0);
  expect(lines + shipping).toBe(order.totalMinor);
  const tax = order.lines.reduce((sum, l) => sum + l.taxMinor, 0) + (order.shipping?.taxMinor ?? 0);
  expect(tax).toBe(order.taxTotalMinor);
  expect(order.lines.reduce((sum, l) => sum + l.discountMinor, 0)).toBe(order.discountTotalMinor);
}

describe('WooCommerce sandbox against the API connector', () => {
  it('lists the store catalog with variable products expanded', async () => {
    const { woo } = harness();
    const products = await woo().listProducts();

    const expected = ZERNO_PRODUCTS.filter((p) => !p.accountingOnly);
    expect(products).toHaveLength(expected.length);
    expect(products.map((p) => p.sku).sort()).toEqual(expected.map((p) => p.sku).sort());
    const filter = products.find((p) => p.sku === 'ZP-V60-FLT-K');
    expect(filter).toMatchObject({ name: 'Фильтры для воронки V60 (Небелёные)', priceMinor: 49_000 });
    expect(filter?.variantId).not.toBeNull();
    expect(products.find((p) => p.sku === 'ZP-GIFT-3000')?.stock).toBeNull();
    expect(products.find((p) => p.sku === 'ZP-KETTLE-GN')?.barcode).toBe('4607012340172');
  });

  it('serves generated orders with totals that add up', async () => {
    const h = harness();
    const factory = new OrderFactory(h.sandbox.state, seededRandom(7));
    const created = factory.createZernoOrder({ payment: 'paid', discountPercent: 10, withStoreOnly: true });
    const order = await h.woo().getOrder(String(created.order.id));

    expect(order).toMatchObject({ currency: 'RUB', payment: { paid: true, method: 'ЮKassa' } });
    expect(order.discountTotalMinor).toBeGreaterThan(0);
    expect(order.lines.some((l) => l.sku === 'ZP-MUG-ENAMEL')).toBe(true);
    assertConsistent(order);

    for (let i = 0; i < 40; i++) {
      const { order: next } = factory.createZernoOrder();
      assertConsistent(await h.woo().getOrder(String(next.id)));
    }
  });

  it('tells paid, awaiting and on-hold orders apart, and finds them by modified date', async () => {
    const h = harness();
    const factory = new OrderFactory(h.sandbox.state, seededRandom(3));
    const before = new Date(Date.now() - 60_000);
    const later = factory.createZernoOrder({ payment: 'later' });
    const pending = factory.createZernoOrder({ payment: 'pending' });
    const woo = h.woo();

    expect((await woo.getOrder(String(later.order.id))).payment.paid).toBe(false);
    expect((await woo.getOrder(String(pending.order.id))).status).toBe('on-hold');
    const found = await woo.listOrdersUpdatedSince(before, 50);
    expect(found.map((o) => o.externalId)).toEqual([String(later.order.id), String(pending.order.id)]);

    factory.markZernoPaid(later.order, new Date(Date.now() + 5_000));
    const paid = await woo.getOrder(String(later.order.id));
    expect(paid.payment).toMatchObject({ paid: true });
    expect(paid.payment.paidAt).not.toBeNull();
    expect(await woo.listOrdersUpdatedSince(new Date(Date.now() + 2_000), 50)).toHaveLength(1);
    await expect(woo.getOrder('1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('accepts stock and price pushes for simple products and variations', async () => {
    const { woo } = harness();
    const connector = woo();
    const products = await connector.listProducts();
    const simple = products.find((p) => p.sku === 'ZP-ETH-250');
    const variation = products.find((p) => p.sku === 'ZP-V60-FLT-W');
    if (!simple || !variation) throw new Error('catalog is missing demo items');

    const stock = await connector.updateStock([
      { ref: simple, quantity: 5 },
      { ref: variation, quantity: 0 },
      { ref: { productId: simple.productId, variantId: '999999' }, quantity: 1 },
    ]);
    expect(stock.updated).toBe(2);
    expect(stock.failed).toHaveLength(1);
    const prices = await connector.updatePrices([
      { ref: simple, priceMinor: 78_900 },
      { ref: variation, priceMinor: 52_000 },
    ]);
    expect(prices).toEqual({ updated: 2, failed: [] });

    const after = await connector.listProducts();
    expect(after.find((p) => p.sku === 'ZP-ETH-250')).toMatchObject({ stock: 5, priceMinor: 78_900 });
    expect(after.find((p) => p.sku === 'ZP-V60-FLT-W')).toMatchObject({ stock: 0, priceMinor: 52_000 });
  });

  it('creates new products as drafts that show up in the listing', async () => {
    const { woo } = harness();
    const connector = woo();
    const ref = await connector.createProduct({
      sku: 'ZP-PAN-250',
      barcode: '4607012340189',
      name: 'Панама Финка Ла Эсмеральда, 250 г',
      description: null,
      priceMinor: 199_000,
      stock: 6,
    });
    expect(ref.variantId).toBeNull();
    const listed = (await connector.listProducts()).find((p) => p.sku === 'ZP-PAN-250');
    expect(listed).toMatchObject({
      productId: ref.productId,
      priceMinor: 199_000,
      stock: 6,
      barcode: '4607012340189',
    });
  });

  it('signs order webhooks the way the connector verifies them', () => {
    const h = harness();
    const { order } = new OrderFactory(h.sandbox.state, seededRandom(1)).createZernoOrder();
    const delivery = wooOrderWebhook(TEST_TOKEN, order, 'created');
    const webhook = { headers: delivery.headers, rawBody: Buffer.from(delivery.body) };
    const connector = h.woo();

    expect(connector.verifyWebhook(webhook, TEST_TOKEN)).toBe(true);
    expect(connector.verifyWebhook(webhook, 'other')).toBe(false);
    expect(connector.parseWebhook(webhook)).toEqual([
      { topic: 'order.created', deliveryId: delivery.deliveryId, entityId: String(order.id) },
    ]);
  });

  it('answers wrong keys with the WooCommerce 401', async () => {
    const { woo } = harness();
    await expect(woo({ consumerSecret: 'nope' }).listProducts()).rejects.toBeInstanceOf(AuthError);
  });
});
