import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { testHttp } from '../../../test/support/journal.js';
import { type RateLimitedError, ValidationRejectedError } from '../../domain/errors.js';
import { hmacSha256 } from '../../security/hmac.js';
import order from './__fixtures__/order.json' with { type: 'json' };
import throttled from './__fixtures__/throttled.json' with { type: 'json' };
import variantsPage1 from './__fixtures__/variants-page-1.json' with { type: 'json' };
import variantsPage2 from './__fixtures__/variants-page-2.json' with { type: 'json' };
import { ShopifyConnector, shopifyErrorPolicy } from './shopify.connector.js';

const BASE = 'https://hillside-tea.myshopify.com/admin/api/2026-10/graphql.json';
const LOCATION = 'gid://shopify/Location/81234567890';
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

interface GqlCall {
  operation: string;
  query: string;
  variables: Record<string, unknown>;
  token: string | null;
}

type Reply = (call: GqlCall) => unknown;

/** one endpoint for every operation; replies are picked by operation name */
function shopify(replies: Record<string, Reply>): GqlCall[] {
  const calls: GqlCall[] = [];
  server.use(
    http.post(BASE, async ({ request }) => {
      const body = (await request.json()) as { query: string; variables: Record<string, unknown> };
      const operation = /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? '';
      const call = { operation, ...body, token: request.headers.get('x-shopify-access-token') };
      calls.push(call);
      const reply = replies[operation];
      return reply ? HttpResponse.json(reply(call) as object) : HttpResponse.json({}, { status: 500 });
    }),
  );
  return calls;
}

function connector(settings: Record<string, unknown> = {}) {
  const { http: client, records } = testHttp('shopify', BASE, shopifyErrorPolicy);
  const shop = new ShopifyConnector({
    connectionId: 'conn_test',
    baseUrl: BASE,
    credentials: { accessToken: 'shpat_9f2c4e1a7b3d5f60' },
    settings: {
      currency: 'GBP',
      locationId: LOCATION,
      shopDomain: 'hillside-tea.myshopify.com',
      ...settings,
    },
    http: client,
  });
  return { shop, records };
}

interface InventoryInput {
  referenceDocumentUri: string;
  quantities: Array<Record<string, unknown>>;
}

const inventoryInput = (call: GqlCall | undefined) => (call?.variables.input ?? {}) as InventoryInput;
const quantitiesOf = (call: GqlCall | undefined) => inventoryInput(call).quantities;

describe('ShopifyConnector', () => {
  it('normalizes a VAT-inclusive order to tax-exclusive lines and shipping', async () => {
    const calls = shopify({ Order: () => order });
    const { shop, records } = connector();
    const result = await shop.getOrder('5987654321');

    expect(calls[0]?.token).toBe('shpat_9f2c4e1a7b3d5f60');
    expect(calls[0]?.variables).toEqual({ id: 'gid://shopify/Order/5987654321' });
    expect(records[0]?.url).toBe(BASE);
    expect(records[0]?.requestHeaders['x-shopify-access-token']).not.toContain('shpat_9f2c');
    expect(result).toMatchObject({
      externalId: '5987654321',
      number: '1042',
      status: 'paid',
      currency: 'GBP',
      totalMinor: 3540,
      taxTotalMinor: 590,
      discountTotalMinor: 291,
      shipping: { title: 'Royal Mail Tracked 48', priceMinor: 329, taxMinor: 66, taxRatePercent: 20 },
      customer: {
        externalId: '7712345678',
        email: 'eleanor.whitcombe@example.co.uk',
        phone: '+447700900123',
        firstName: 'Eleanor',
        address: { line1: '27 Mill Lane', city: 'Hebden Bridge', postcode: 'HX7 8AB', country: 'GB' },
      },
      payment: { paid: true, method: 'shopify_payments', transactionId: '7123456789' },
      adminUrl: 'https://admin.shopify.com/store/hillside-tea/orders/5987654321',
    });
    expect(result.payment.paidAt?.toISOString()).toBe('2026-10-18T10:22:41.000Z');
    expect(
      result.lines.map(({ sku, unitPriceMinor, discountMinor, taxMinor, totalMinor }) => ({
        sku,
        unitPriceMinor,
        discountMinor,
        taxMinor,
        totalMinor,
      })),
    ).toEqual([
      { sku: 'HT-ASM-250', unitPriceMinor: 708, discountMinor: 141, taxMinor: 255, totalMinor: 1275 },
      { sku: 'HT-DJ1-100', unitPriceMinor: 1000, discountMinor: 100, taxMinor: 180, totalMinor: 900 },
      { sku: 'HT-INF-01', unitPriceMinor: 496, discountMinor: 50, taxMinor: 89, totalMinor: 446 },
    ]);
    expect(result.lines[0]).toMatchObject({
      externalId: '15012345678001',
      productExternalId: '9012345670011',
      variantExternalId: '47123456780011',
      quantity: 2,
      taxRatePercent: 20,
    });
    const net = result.lines.reduce((sum, l) => sum + l.totalMinor, 0) + (result.shipping?.priceMinor ?? 0);
    expect(net + result.taxTotalMinor).toBe(result.totalMinor);
  });

  it('keeps amounts as they are when the shop prices exclude tax', async () => {
    const exclusive = structuredClone(order);
    exclusive.data.order.taxesIncluded = false;
    shopify({ Order: () => exclusive });
    const result = await connector().shop.getOrder('gid://shopify/Order/5987654321');
    expect(result.lines[0]).toMatchObject({ unitPriceMinor: 850, discountMinor: 170, totalMinor: 1530 });
    expect(result.shipping?.priceMinor).toBe(395);
  });

  it('lists orders changed since a date, oldest first', async () => {
    const calls = shopify({
      OrdersUpdatedSince: () => ({ data: { orders: { nodes: [{ id: 'gid://shopify/Order/5987654321' }] } } }),
      Order: () => order,
    });
    const orders = await connector().shop.listOrdersUpdatedSince(new Date('2026-10-18T00:00:00Z'), 500);
    expect(calls[0]?.variables).toEqual({ first: 20, query: "updated_at:>'2026-10-18T00:00:00.000Z'" });
    expect(calls[0]?.query).toContain('sortKey: UPDATED_AT');
    expect(orders.map((o) => o.number)).toEqual(['1042']);
  });

  it('walks variant pages and builds names, barcodes and stock', async () => {
    const calls = shopify({ Variants: ({ variables }) => (variables.after ? variantsPage2 : variantsPage1) });
    const products = await connector().shop.listProducts();

    expect(calls.map((c) => c.variables.after)).toEqual([null, 'eyJsYXN0X2lkIjo0NzEyMzQ1Njc4MDAxMn0=']);
    expect(products).toEqual([
      {
        productId: '9012345670011',
        variantId: '47123456780011',
        inventoryItemId: '49123456780011',
        sku: 'HT-ASM-250',
        barcode: '5060123450011',
        name: 'Assam Breakfast Loose Leaf (250g)',
        priceMinor: 850,
        stock: 64,
      },
      {
        productId: '9012345670011',
        variantId: '47123456780012',
        inventoryItemId: '49123456780012',
        sku: 'HT-ASM-1000',
        barcode: null,
        name: 'Assam Breakfast Loose Leaf (1kg)',
        priceMinor: 2700,
        stock: 9,
      },
      {
        productId: '9012345670041',
        variantId: '47123456780041',
        inventoryItemId: '49123456780041',
        sku: 'HT-GIFT-CARD',
        barcode: null,
        name: 'Hillside Tea Gift Card',
        priceMinor: 2500,
        stock: null,
      },
    ]);
  });

  it('sets available stock with an idempotency key derived from the content', async () => {
    const calls = shopify({ InventorySet: () => ({ data: { inventorySetQuantities: { userErrors: [] } } }) });
    const { shop } = connector();
    const assam = {
      productId: '9012345670011',
      variantId: '47123456780011',
      inventoryItemId: '49123456780011',
    };
    const updates = [
      { ref: assam, quantity: 58 },
      { ref: { productId: '9012345670021', variantId: '47123456780021' }, quantity: 12 },
    ];
    const first = await shop.updateStock(updates);
    await shop.updateStock(updates);
    await shop.updateStock([{ ref: assam, quantity: 57 }]);

    expect(first.updated).toBe(1);
    expect(first.failed).toEqual([
      { ref: updates[1]?.ref, reason: 'No Shopify inventory item id, refresh the product list' },
    ]);
    const [a, b, c] = calls;
    expect(a?.query).toContain('@idempotent(key: $idempotencyKey)');
    expect(a?.variables.input).toMatchObject({ name: 'available', reason: 'correction' });
    expect(quantitiesOf(a)).toEqual([
      {
        inventoryItemId: 'gid://shopify/InventoryItem/49123456780011',
        locationId: LOCATION,
        quantity: 58,
        changeFromQuantity: null,
      },
    ]);
    const key = a?.variables.idempotencyKey;
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(b?.variables.idempotencyKey).toBe(key);
    expect(c?.variables.idempotencyKey).not.toBe(key);
    expect(inventoryInput(a).referenceDocumentUri).toBe(`gid://shop-accounting-sync/StockSync/${key}`);
  });

  it('splits stock updates into chunks of 250 and fails a chunk on user errors', async () => {
    let call = 0;
    shopify({
      InventorySet: () => {
        call += 1;
        const userErrors =
          call === 2
            ? [{ field: ['input', 'quantities', '0', 'quantity'], message: 'Quantity is too large' }]
            : [];
        return { data: { inventorySetQuantities: { userErrors } } };
      },
    });
    const updates = Array.from({ length: 251 }, (_, i) => ({
      ref: { productId: '9012345670011', variantId: null, inventoryItemId: String(49123456790000 + i) },
      quantity: 10,
    }));
    const result = await connector().shop.updateStock(updates);
    expect(call).toBe(2);
    expect(result.updated).toBe(250);
    expect(result.failed).toEqual([
      { ref: updates[250]?.ref, reason: 'input.quantities.0.quantity: Quantity is too large' },
    ]);
  });

  it('updates prices per product and reports variant user errors as failures', async () => {
    const calls = shopify({
      VariantsBulkUpdate: ({ variables }) => ({
        data: {
          productVariantsBulkUpdate: {
            userErrors:
              variables.productId === 'gid://shopify/Product/9012345670011'
                ? [{ field: ['variants', '1', 'price'], message: 'Price must be greater than or equal to 0' }]
                : [],
          },
        },
      }),
    });
    const bad = { productId: '9012345670011', variantId: '47123456780012' };
    const result = await connector().shop.updatePrices([
      { ref: { productId: '9012345670011', variantId: '47123456780011' }, priceMinor: 895 },
      { ref: bad, priceMinor: -100 },
      { ref: { productId: '9012345670021', variantId: '47123456780021' }, priceMinor: 1250 },
    ]);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.query).toContain('allowPartialUpdates: true');
    expect(calls[0]?.variables).toEqual({
      productId: 'gid://shopify/Product/9012345670011',
      variants: [
        { id: 'gid://shopify/ProductVariant/47123456780011', price: '8.95' },
        { id: 'gid://shopify/ProductVariant/47123456780012', price: '-1.00' },
      ],
    });
    expect(result.updated).toBe(2);
    expect(result.failed).toEqual([{ ref: bad, reason: 'Price must be greater than or equal to 0' }]);
  });

  it('creates a draft product, then fills the default variant and stock', async () => {
    const calls = shopify({
      ProductCreate: () => ({
        data: {
          productCreate: {
            product: {
              id: 'gid://shopify/Product/9012345670051',
              variants: {
                nodes: [
                  {
                    id: 'gid://shopify/ProductVariant/47123456780051',
                    inventoryItem: { id: 'gid://shopify/InventoryItem/49123456780051' },
                  },
                ],
              },
            },
            userErrors: [],
          },
        },
      }),
      VariantsBulkUpdate: () => ({ data: { productVariantsBulkUpdate: { userErrors: [] } } }),
      InventorySet: () => ({ data: { inventorySetQuantities: { userErrors: [] } } }),
    });
    const ref = await connector().shop.createProduct({
      sku: 'HT-SEN-100',
      barcode: '5060123450051',
      name: 'Japanese Sencha',
      description: 'Steamed green tea from Shizuoka, grassy and sweet.',
      priceMinor: 1150,
      stock: 30,
    });

    expect(ref).toEqual({
      productId: '9012345670051',
      variantId: '47123456780051',
      inventoryItemId: '49123456780051',
    });
    expect(calls.map((c) => c.operation)).toEqual(['ProductCreate', 'VariantsBulkUpdate', 'InventorySet']);
    expect(calls[0]?.variables.product).toMatchObject({ title: 'Japanese Sencha', status: 'DRAFT' });
    expect(calls[1]?.variables.variants).toEqual([
      {
        id: 'gid://shopify/ProductVariant/47123456780051',
        price: '11.50',
        barcodes: [{ value: '5060123450051' }],
        inventoryItem: { sku: 'HT-SEN-100', tracked: true },
      },
    ]);
    expect(quantitiesOf(calls[2])[0]).toMatchObject({ quantity: 30, locationId: LOCATION });
  });

  it('throws on productCreate user errors', async () => {
    shopify({
      ProductCreate: () => ({
        data: {
          productCreate: {
            product: null,
            userErrors: [{ field: ['title'], message: "Title can't be blank" }],
          },
        },
      }),
    });
    const error = await connector()
      .shop.createProduct({ sku: 'X', barcode: null, name: '', description: null, priceMinor: 0, stock: 0 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationRejectedError);
    expect((error as ValidationRejectedError).detail).toBe("title: Title can't be blank");
  });

  it('turns THROTTLED into a rate limit with the delay the bucket needs to refill', async () => {
    shopify({ Order: () => throttled });
    const error = await connector()
      .shop.getOrder('5987654321')
      .catch((e: unknown) => e);
    // (752 requested - 352 available) / 100 per second
    expect((error as RateLimitedError).code).toBe('rate_limited');
    expect((error as RateLimitedError).retryAfterMs).toBe(4000);
  });

  it('turns GraphQL errors into validation errors and 429s into rate limits', async () => {
    server.use(
      http.post(BASE, async ({ request }) => {
        const body = (await request.json()) as { variables: { id: string } };
        if (body.variables.id.endsWith('/1')) return new HttpResponse(null, { status: 429 });
        return HttpResponse.json({
          errors: [
            { message: "Field 'nmae' doesn't exist on type 'Order'", extensions: { code: 'undefinedField' } },
          ],
        });
      }),
    );
    const { shop } = connector();
    const invalid = await shop.getOrder('2').catch((e: unknown) => e);
    expect(invalid).toBeInstanceOf(ValidationRejectedError);
    expect((invalid as ValidationRejectedError).detail).toBe("Field 'nmae' doesn't exist on type 'Order'");
    const limited = await shop.getOrder('1').catch((e: unknown) => e);
    expect((limited as RateLimitedError).retryAfterMs).toBe(2000);
  });

  it('verifies webhook signatures and maps topics', () => {
    const { shop } = connector();
    const rawBody = Buffer.from(JSON.stringify({ id: 5987654321, name: '#1042' }));
    const headers = (topic: string) => ({
      'x-shopify-hmac-sha256': hmacSha256('shpss_whsec', rawBody),
      'x-shopify-topic': topic,
      'x-shopify-webhook-id': 'b54557e4-bdd9-4b37-8a5f-bf7d70bcd043',
    });
    expect(shop.verifyWebhook({ headers: headers('orders/create'), rawBody }, 'shpss_whsec')).toBe(true);
    expect(shop.verifyWebhook({ headers: headers('orders/create'), rawBody }, 'other')).toBe(false);
    expect(shop.parseWebhook({ headers: headers('orders/paid'), rawBody })).toEqual([
      { topic: 'order.paid', deliveryId: 'b54557e4-bdd9-4b37-8a5f-bf7d70bcd043', entityId: '5987654321' },
    ]);
    expect(shop.parseWebhook({ headers: headers('products/update'), rawBody })[0]?.topic).toBe(
      'product.updated',
    );
    expect(shop.parseWebhook({ headers: headers('customers/create'), rawBody })).toEqual([]);
  });
});
