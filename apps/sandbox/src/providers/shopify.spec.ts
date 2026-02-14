import { HILLSIDE_PRODUCTS, SANDBOX_PATHS } from '@sas/demo-data';
import { describe, expect, it } from 'vitest';
import { AuthError, NotFoundError } from '../../../api/src/domain/errors.js';
import type { StoreOrder } from '../../../api/src/domain/models.js';
import { OrderFactory } from '../orders.js';
import { seededRandom } from '../random.js';
import { harness, TEST_TOKEN, TEST_URL } from '../testing/harness.js';
import { shopifyOrderWebhook } from '../webhooks.js';

function assertConsistent(order: StoreOrder): void {
  const lines = order.lines.reduce((sum, l) => sum + l.totalMinor + l.taxMinor, 0);
  const shipping = (order.shipping?.priceMinor ?? 0) + (order.shipping?.taxMinor ?? 0);
  expect(lines + shipping).toBe(order.totalMinor);
  const tax = order.lines.reduce((sum, l) => sum + l.taxMinor, 0) + (order.shipping?.taxMinor ?? 0);
  expect(tax).toBe(order.taxTotalMinor);
  for (const line of order.lines) {
    expect(line.unitPriceMinor * line.quantity - line.discountMinor).toBe(line.totalMinor);
  }
}

describe('Shopify sandbox against the API connector', () => {
  it('pages through every variant with inventory item ids', async () => {
    const { shopify } = harness();
    const products = await shopify().listProducts();

    const expected = HILLSIDE_PRODUCTS.filter((p) => !p.accountingOnly);
    expect(products.map((p) => p.sku).sort()).toEqual(expected.map((p) => p.sku).sort());
    expect(products.every((p) => p.inventoryItemId && p.variantId)).toBe(true);
    const teapots = products.filter((p) => p.sku.startsWith('HT-POT-CAST'));
    expect(teapots.map((p) => p.name)).toEqual(['Cast iron teapot (0.6 L)', 'Cast iron teapot (1.2 L)']);
    expect(new Set(teapots.map((p) => p.productId)).size).toBe(1);
    expect(products.find((p) => p.sku === 'HT-GIFTCARD-25')?.stock).toBeNull();
  });

  it('serves VAT-inclusive orders the connector can split into net lines', async () => {
    const h = harness();
    const factory = new OrderFactory(h.sandbox.state, seededRandom(11));
    const { order } = factory.createHillsideOrder({ payment: 'paid', discountPercent: 12 });
    const result = await h.shopify().getOrder(String(order.id));

    expect(result).toMatchObject({
      externalId: String(order.id),
      number: String(order.number),
      currency: 'GBP',
      status: 'paid',
      payment: { paid: true, method: 'shopify_payments' },
    });
    expect(result.discountTotalMinor).toBeGreaterThan(0);
    assertConsistent(result);

    // 20 is well inside the cost bucket: each full order query asks for 642 points and keeps 48
    for (let i = 0; i < 20; i++) {
      const { order: next } = factory.createHillsideOrder();
      assertConsistent(await h.shopify().getOrder(String(next.id)));
    }
  });

  it('marks an authorised order paid once it is captured and lists it by updated_at', async () => {
    const h = harness();
    const factory = new OrderFactory(h.sandbox.state, seededRandom(5));
    const since = new Date(Date.now() - 60_000);
    const { order } = factory.createHillsideOrder({ payment: 'later' });
    const shop = h.shopify();

    expect((await shop.getOrder(String(order.id))).payment.paid).toBe(false);
    factory.markHillsidePaid(order, new Date(Date.now() + 5_000));
    expect((await shop.getOrder(String(order.id))).payment).toMatchObject({ paid: true });
    expect((await shop.listOrdersUpdatedSince(since, 10)).map((o) => o.externalId)).toEqual([
      String(order.id),
    ]);
    expect(await shop.listOrdersUpdatedSince(new Date(Date.now() + 2_000), 10)).toHaveLength(1);
    expect(await shop.listOrdersUpdatedSince(new Date(Date.now() + 60_000), 10)).toHaveLength(0);
  });

  it('applies inventorySetQuantities and productVariantsBulkUpdate', async () => {
    const { shopify } = harness();
    const shop = shopify();
    const products = await shop.listProducts();
    const sencha = products.find((p) => p.sku === 'HT-SEN-100');
    const teapot = products.find((p) => p.sku === 'HT-POT-CAST-L');
    if (!sencha || !teapot) throw new Error('catalog is missing demo items');

    expect(
      await shop.updateStock([
        { ref: sencha, quantity: 3 },
        { ref: teapot, quantity: 11 },
      ]),
    ).toEqual({
      updated: 2,
      failed: [],
    });
    expect(await shop.updatePrices([{ ref: sencha, priceMinor: 1195 }])).toEqual({ updated: 1, failed: [] });
    const missing = await shop.updatePrices([{ ref: { ...teapot, variantId: '1' }, priceMinor: 1 }]);
    expect(missing.failed[0]?.reason).toBe('Product variant does not exist');

    const after = await shop.listProducts();
    expect(after.find((p) => p.sku === 'HT-SEN-100')).toMatchObject({ stock: 3, priceMinor: 1195 });
    expect(after.find((p) => p.sku === 'HT-POT-CAST-L')).toMatchObject({ stock: 11, priceMinor: 4500 });
  });

  it('creates a draft product whose default variant gets sku, barcode, price and stock', async () => {
    const { shopify } = harness();
    const shop = shopify();
    const ref = await shop.createProduct({
      sku: 'HT-YER-100',
      barcode: '5060411320168',
      name: 'Yerba mate, 100 g',
      description: 'South American mate',
      priceMinor: 700,
      stock: 20,
    });
    const listed = (await shop.listProducts()).find((p) => p.sku === 'HT-YER-100');
    expect(listed).toMatchObject({
      productId: ref.productId,
      variantId: ref.variantId,
      barcode: '5060411320168',
      name: 'Yerba mate, 100 g',
      priceMinor: 700,
      stock: 20,
    });
  });

  it('signs webhooks with the shared secret and puts the numeric id in the body', () => {
    const h = harness();
    const { order } = new OrderFactory(h.sandbox.state, seededRandom(2)).createHillsideOrder();
    const delivery = shopifyOrderWebhook(TEST_TOKEN, order, 'orders/create');
    const webhook = { headers: delivery.headers, rawBody: Buffer.from(delivery.body) };
    const shop = h.shopify();

    expect(shop.verifyWebhook(webhook, TEST_TOKEN)).toBe(true);
    expect(shop.parseWebhook(webhook)).toEqual([
      { topic: 'order.created', deliveryId: delivery.deliveryId, entityId: String(order.id) },
    ]);
  });

  it('rejects a bad token and reports unknown queries as GraphQL errors', async () => {
    const h = harness();
    await expect(h.shopify({ accessToken: 'shpat_wrong' }).listProducts()).rejects.toBeInstanceOf(AuthError);

    const res = await h.fetchImpl(`${TEST_URL}${SANDBOX_PATHS.shopify}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shopify-access-token': TEST_TOKEN },
      body: JSON.stringify({ query: 'query Shop { shop { name } }' }),
    });
    expect(await res.json()).toMatchObject({
      errors: [{ message: "Field 'shop' doesn't exist on type 'QueryRoot'" }],
    });
    await expect(h.shopify().getOrder('404')).rejects.toBeInstanceOf(NotFoundError);
  });
});
