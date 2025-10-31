import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { testHttp } from '../../../test/support/journal.js';
import { type RateLimitedError, ValidationRejectedError } from '../../domain/errors.js';
import { hmacSha256 } from '../../security/hmac.js';
import order from './__fixtures__/order.json' with { type: 'json' };
import { WooCommerceConnector, wooErrorPolicy } from './woocommerce.connector.js';

const BASE = 'https://zerno.test/wp-json/wc/v3';
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function connector() {
  const { http: client, records } = testHttp('woocommerce', BASE, wooErrorPolicy);
  const wc = new WooCommerceConnector({
    connectionId: 'conn_test',
    baseUrl: BASE,
    credentials: { consumerKey: 'ck_live_123', consumerSecret: 'cs_live_456' },
    settings: { currency: 'RUB', siteUrl: 'https://zerno.test' },
    http: client,
  });
  return { wc, records };
}

describe('WooCommerceConnector', () => {
  it('normalizes an order: lines, discounts, VAT, shipping and payment', async () => {
    let auth: string | null = null;
    server.use(
      http.get(`${BASE}/orders/4127`, ({ request }) => {
        auth = request.headers.get('authorization');
        return HttpResponse.json(order);
      }),
    );
    const { wc, records } = connector();
    const result = await wc.getOrder('4127');

    expect(auth).toBe(`Basic ${Buffer.from('ck_live_123:cs_live_456').toString('base64')}`);
    expect(records[0]?.requestHeaders.authorization).not.toContain('Y2tf');
    expect(result).toMatchObject({
      externalId: '4127',
      currency: 'RUB',
      totalMinor: 246000,
      taxTotalMinor: 44361,
      discountTotalMinor: 15000,
      payment: { paid: true, method: 'ЮKassa' },
      customer: { email: 'm.kotova@example.ru', address: { city: 'Санкт-Петербург' } },
      shipping: { title: 'Курьер по городу', priceMinor: 23770, taxMinor: 5230, taxRatePercent: 22 },
      adminUrl: 'https://zerno.test/wp-admin/post.php?post=4127&action=edit',
    });
    expect(result.createdAt.toISOString()).toBe('2026-10-18T09:14:03.000Z');
    expect(result.lines[0]).toMatchObject({
      sku: 'ZP-ETH-250',
      quantity: 2,
      unitPriceMinor: 61476,
      discountMinor: 12295,
      taxRatePercent: 22,
      totalMinor: 110656,
    });
    expect(result.lines[1]).toMatchObject({ variantExternalId: '345', taxRatePercent: null });
  });

  it('pushes stock in batches split by parent product', async () => {
    const bodies: Record<string, unknown> = {};
    server.use(
      http.post(`${BASE}/products/batch`, async ({ request }) => {
        bodies.simple = await request.json();
        return HttpResponse.json({ update: [{ id: 312 }] });
      }),
      http.post(`${BASE}/products/340/variations/batch`, async ({ request }) => {
        bodies.variations = await request.json();
        return HttpResponse.json({
          update: [
            { id: 345 },
            { id: 346, error: { code: 'woocommerce_rest_invalid_id', message: 'Invalid ID.' } },
          ],
        });
      }),
    );
    const { wc } = connector();
    const result = await wc.updateStock([
      { ref: { productId: '312', variantId: null }, quantity: 14 },
      { ref: { productId: '340', variantId: '345' }, quantity: 3 },
      { ref: { productId: '340', variantId: '346' }, quantity: 0 },
    ]);

    expect(bodies.simple).toEqual({ update: [{ id: 312, manage_stock: true, stock_quantity: 14 }] });
    expect(bodies.variations).toEqual({
      update: [
        { id: 345, manage_stock: true, stock_quantity: 3 },
        { id: 346, manage_stock: true, stock_quantity: 0 },
      ],
    });
    expect(result.updated).toBe(2);
    expect(result.failed).toEqual([{ ref: { productId: '340', variantId: '346' }, reason: 'Invalid ID.' }]);
  });

  it('sends prices as decimal strings', async () => {
    let body: unknown;
    server.use(
      http.post(`${BASE}/products/batch`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ update: [{ id: 312 }] });
      }),
    );
    await connector().wc.updatePrices([{ ref: { productId: '312', variantId: null }, priceMinor: 74900 }]);
    expect(body).toEqual({ update: [{ id: 312, regular_price: '749.00' }] });
  });

  it('walks pagination and expands variable products', async () => {
    server.use(
      http.get(`${BASE}/products`, ({ request }) => {
        const page = new URL(request.url).searchParams.get('page');
        const rows =
          page === '1'
            ? [
                {
                  id: 312,
                  name: 'Эфиопия',
                  type: 'simple',
                  sku: 'ZP-ETH-250',
                  regular_price: '749',
                  price: '749',
                  manage_stock: true,
                  stock_quantity: 20,
                  variations: [],
                },
              ]
            : [
                {
                  id: 340,
                  name: 'Фильтры V60',
                  type: 'variable',
                  sku: '',
                  regular_price: '',
                  price: '',
                  manage_stock: false,
                  stock_quantity: null,
                  variations: [345],
                },
              ];
        return HttpResponse.json(rows, { headers: { 'x-wp-totalpages': '2' } });
      }),
      http.get(`${BASE}/products/340/variations`, () =>
        HttpResponse.json([
          {
            id: 345,
            sku: 'ZP-V60-FLT-W',
            global_unique_id: '4607001234567',
            regular_price: '490',
            price: '490',
            manage_stock: true,
            stock_quantity: 8,
            attributes: [{ name: 'Цвет', option: 'Белые' }],
          },
        ]),
      ),
    );
    const products = await connector().wc.listProducts();
    expect(products).toEqual([
      {
        productId: '312',
        variantId: null,
        sku: 'ZP-ETH-250',
        barcode: null,
        name: 'Эфиопия',
        priceMinor: 74900,
        stock: 20,
      },
      {
        productId: '340',
        variantId: '345',
        sku: 'ZP-V60-FLT-W',
        barcode: '4607001234567',
        name: 'Фильтры V60 (Белые)',
        priceMinor: 49000,
        stock: 8,
      },
    ]);
  });

  it('turns provider errors into typed sync errors', async () => {
    server.use(
      http.get(`${BASE}/orders/1`, () =>
        HttpResponse.json(
          { code: 'woocommerce_rest_shop_order_invalid_id', message: 'Invalid ID.' },
          { status: 400 },
        ),
      ),
      http.get(
        `${BASE}/orders/2`,
        () => new HttpResponse(null, { status: 429, headers: { 'retry-after': '7' } }),
      ),
    );
    const { wc } = connector();
    const invalid = await wc.getOrder('1').catch((e: unknown) => e);
    expect(invalid).toBeInstanceOf(ValidationRejectedError);
    expect((invalid as ValidationRejectedError).detail).toContain('Invalid ID.');
    const limited = await wc.getOrder('2').catch((e: unknown) => e);
    expect((limited as RateLimitedError).retryAfterMs).toBe(7000);
  });

  it('verifies webhook signatures and reads delivery ids', () => {
    const { wc } = connector();
    const rawBody = Buffer.from(JSON.stringify({ id: 4127 }));
    const headers = {
      'x-wc-webhook-signature': hmacSha256('whsec', rawBody),
      'x-wc-webhook-topic': 'order.created',
      'x-wc-webhook-delivery-id': 'a1b2',
    };
    expect(wc.verifyWebhook({ headers, rawBody }, 'whsec')).toBe(true);
    expect(wc.verifyWebhook({ headers, rawBody }, 'other')).toBe(false);
    expect(wc.parseWebhook({ headers, rawBody })).toEqual([
      { topic: 'order.created', deliveryId: 'a1b2', entityId: '4127' },
    ]);
  });
});
