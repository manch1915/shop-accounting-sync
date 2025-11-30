import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { testHttp } from '../../../test/support/journal.js';
import { RateLimitedError, ValidationRejectedError } from '../../domain/errors.js';
import type { SalesDocumentInput } from '../../domain/models.js';
import customerOrder from './__fixtures__/customerorder.json' with { type: 'json' };
import paymentIn from './__fixtures__/paymentin.json' with { type: 'json' };
import products from './__fixtures__/products.json' with { type: 'json' };
import productWebhook from './__fixtures__/webhook-product.json' with { type: 'json' };
import { MoySkladConnector, moySkladErrorPolicy } from './moysklad.connector.js';

const BASE = 'https://api.moysklad.test/api/remap/1.2';
const ORG = '1d4e5f60-5b2e-11f1-0a80-0d6a00130001';
const STORE = '1d4e5f60-5b2e-11f1-0a80-0d6a00130010';
const STATE = '1d4e5f60-5b2e-11f1-0a80-0d6a00130020';
const AGENT = '7a2b3c4d-ac5e-11f1-0a80-1a2b000a5501';
const ETHIOPIA = '8f1c2a10-5b2e-11f1-0a80-0d6a00145e21';
const FILTERS = '8f1c2a10-5b2e-11f1-0a80-0d6a00145e35';
const DELIVERY = '9e0f1a2b-5b2e-11f1-0a80-0d6a00150001';
const ORDER_ID = customerOrder.id;

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function connector(settings: Record<string, unknown> = {}) {
  const { http: client, records } = testHttp('moysklad', BASE, moySkladErrorPolicy);
  const ms = new MoySkladConnector({
    connectionId: 'conn_test',
    baseUrl: BASE,
    credentials: { token: 'ms_token_7f3a9c21e4' },
    settings: { organizationId: ORG, currency: 'RUB', ...settings },
    http: client,
  });
  return { ms, records };
}

const meta = (type: string, path: string) => ({
  meta: { href: `${BASE}/entity/${path}`, type, mediaType: 'application/json' },
});

const list = <T>(rows: T[]) => ({ meta: { href: BASE, size: rows.length, limit: 1000, offset: 0 }, rows });

const orderInput: SalesDocumentInput = {
  externalRef: 'woocommerce:4127',
  number: 'WEB-4127',
  date: new Date('2026-10-18T09:14:03Z'),
  currency: 'RUB',
  customerId: AGENT,
  lines: [
    {
      accountingProductId: ETHIOPIA,
      name: 'Кофе в зёрнах Эфиопия Иргачеффе, 250 г',
      quantity: 2,
      unitPriceMinor: 61476,
      discountPercent: 10,
      taxCode: '22',
      taxRatePercent: 22,
    },
    {
      accountingProductId: FILTERS,
      name: 'Фильтры бумажные для V60, белые, 100 шт',
      quantity: 1,
      unitPriceMinor: 49000,
      discountPercent: 0,
      taxCode: 'none',
      taxRatePercent: 0,
    },
  ],
  shipping: { name: 'Курьер по городу', priceMinor: 23770, taxCode: '22', taxRatePercent: 22 },
  pricesIncludeTax: false,
  warehouseId: STORE,
  statusId: STATE,
  comment: 'Позвонить за час до доставки',
};

describe('MoySkladConnector', () => {
  it('creates a customer order with meta links, discounts, VAT and a delivery position', async () => {
    let body: unknown;
    let headers: Headers | undefined;
    let serviceLookups = 0;
    let createdService: unknown;
    server.use(
      http.get(`${BASE}/entity/service`, ({ request }) => {
        serviceLookups += 1;
        expect(new URL(request.url).searchParams.get('filter')).toBe('name=Доставка');
        return HttpResponse.json(list([]));
      }),
      http.post(`${BASE}/entity/service`, async ({ request }) => {
        createdService = await request.json();
        return HttpResponse.json({ id: DELIVERY, name: 'Доставка' });
      }),
      http.post(`${BASE}/entity/customerorder`, async ({ request }) => {
        headers = request.headers;
        body = await request.json();
        return HttpResponse.json(customerOrder);
      }),
    );
    const { ms, records } = connector();
    const ref = await ms.createSalesDocument(orderInput);

    expect(headers?.get('authorization')).toBe('Bearer ms_token_7f3a9c21e4');
    expect(headers?.get('accept-encoding')).toBe('gzip');
    expect(records.at(-1)?.requestHeaders.authorization).not.toContain('7f3a9c');
    expect(createdService).toEqual({ name: 'Доставка' });
    expect(body).toEqual({
      name: 'WEB-4127',
      externalCode: 'woocommerce:4127',
      moment: '2026-10-18 12:14:03',
      organization: meta('organization', `organization/${ORG}`),
      agent: meta('counterparty', `counterparty/${AGENT}`),
      store: meta('store', `store/${STORE}`),
      state: meta('state', `customerorder/metadata/states/${STATE}`),
      description: 'Позвонить за час до доставки',
      vatEnabled: true,
      vatIncluded: false,
      positions: [
        {
          quantity: 2,
          price: 61476,
          discount: 10,
          vat: 22,
          vatEnabled: true,
          assortment: meta('product', `product/${ETHIOPIA}`),
        },
        {
          quantity: 1,
          price: 49000,
          discount: 0,
          vat: 0,
          vatEnabled: false,
          assortment: meta('product', `product/${FILTERS}`),
        },
        {
          quantity: 1,
          price: 23770,
          discount: 0,
          vat: 22,
          vatEnabled: true,
          assortment: meta('service', `service/${DELIVERY}`),
        },
      ],
    });
    expect(ref).toEqual({
      externalId: ORDER_ID,
      number: 'WEB-4127',
      url: `https://online.moysklad.ru/app/#customerorder/edit?id=${ORDER_ID}`,
    });

    await ms.createSalesDocument(orderInput);
    expect(serviceLookups).toBe(1);
  });

  it('uses the configured delivery service and skips optional links', async () => {
    let body: { store?: unknown; state?: unknown; positions: Array<{ assortment: unknown }> } | undefined;
    server.use(
      http.post(`${BASE}/entity/customerorder`, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return HttpResponse.json(customerOrder);
      }),
    );
    const { ms } = connector({ deliveryServiceId: DELIVERY, uiUrl: 'https://ms.zerno.test/app/' });
    const ref = await ms.createSalesDocument({ ...orderInput, warehouseId: null, statusId: null });

    expect(body?.store).toBeUndefined();
    expect(body?.state).toBeUndefined();
    expect(body?.positions.at(-1)?.assortment).toEqual(meta('service', `service/${DELIVERY}`));
    expect(ref.url).toBe(`https://ms.zerno.test/app/#customerorder/edit?id=${ORDER_ID}`);
  });

  it('finds an order created earlier by its externalCode', async () => {
    const filters: Array<string | null> = [];
    server.use(
      http.get(`${BASE}/entity/customerorder`, ({ request }) => {
        const filter = new URL(request.url).searchParams.get('filter');
        filters.push(filter);
        return HttpResponse.json(list(filter === 'externalCode=woocommerce:4127' ? [customerOrder] : []));
      }),
    );
    const { ms } = connector();

    expect(await ms.findSalesDocument('woocommerce:4127')).toMatchObject({
      externalId: ORDER_ID,
      number: 'WEB-4127',
    });
    expect(await ms.findSalesDocument('woocommerce:9999')).toBeNull();
    expect(filters).toEqual(['externalCode=woocommerce:4127', 'externalCode=woocommerce:9999']);
  });

  it('reuses only counterparties carrying our key and never searches by email', async () => {
    const filters: Array<string | null> = [];
    let created: unknown;
    server.use(
      http.get(`${BASE}/entity/counterparty`, ({ request }) => {
        const filter = new URL(request.url).searchParams.get('filter');
        filters.push(filter);
        return HttpResponse.json(
          list(
            filter === 'externalCode=woo-c87' ? [{ id: AGENT, name: 'Котова', externalCode: 'woo-c87' }] : [],
          ),
        );
      }),
      http.post(`${BASE}/entity/counterparty`, async ({ request }) => {
        created = await request.json();
        return HttpResponse.json({
          id: '7a2b3c4d-ac5e-11f1-0a80-1a2b000a5502',
          name: 'ООО «Кофейня на Мойке»',
        });
      }),
    );
    const { ms } = connector();
    const customer = {
      matchKey: 'woo-c87',
      externalId: '87',
      email: 'm.kotova@example.ru',
      phone: '+79110000000',
      firstName: 'Марина',
      lastName: 'Котова',
      company: null,
      address: null,
    };

    expect(await ms.upsertCustomer(customer)).toBe(AGENT);
    expect(created).toBeUndefined();

    const id = await ms.upsertCustomer({
      ...customer,
      matchKey: 'woo-g5b1e0c2a9d4f',
      email: 'zakupki@kofe-moika.ru',
      phone: null,
      company: 'ООО «Кофейня на Мойке»',
      address: {
        line1: 'наб. реки Мойки, 40',
        line2: null,
        city: 'Санкт-Петербург',
        postcode: '191186',
        region: null,
        country: 'RU',
      },
    });
    expect(filters).toEqual(['externalCode=woo-c87', 'externalCode=woo-g5b1e0c2a9d4f']);
    expect(id).toBe('7a2b3c4d-ac5e-11f1-0a80-1a2b000a5502');
    expect(created).toEqual({
      externalCode: 'woo-g5b1e0c2a9d4f',
      name: 'ООО «Кофейня на Мойке»',
      email: 'zakupki@kofe-moika.ru',
      actualAddress: '191186, RU, Санкт-Петербург, наб. реки Мойки, 40',
      companyType: 'legal',
    });
  });

  it('refuses to look a customer up without our key', async () => {
    const { ms } = connector();
    await expect(
      ms.upsertCustomer({
        externalId: null,
        email: 'x@example.ru;name=a',
        phone: null,
        firstName: 'X',
        lastName: 'Y',
        company: null,
        address: null,
      }),
    ).rejects.toThrow(/matchKey/);
  });

  it('registers an incoming payment linked to the order', async () => {
    let body: unknown;
    server.use(
      http.post(`${BASE}/entity/paymentin`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(paymentIn);
      }),
    );
    const ref = await connector().ms.registerPayment({
      document: { externalId: ORDER_ID, number: 'WEB-4127', url: null },
      customerId: AGENT,
      amountMinor: 246000,
      currency: 'RUB',
      paidAt: new Date('2026-10-18T09:15:39Z'),
      reference: 'ЮKassa 2f9a1c7e-000f-5000-9000-1b7c3c1d2e4f',
    });

    expect(body).toEqual({
      organization: meta('organization', `organization/${ORG}`),
      agent: meta('counterparty', `counterparty/${AGENT}`),
      sum: 246000,
      moment: '2026-10-18 12:15:39',
      paymentPurpose: 'ЮKassa 2f9a1c7e-000f-5000-9000-1b7c3c1d2e4f',
      operations: [{ ...meta('customerorder', `customerorder/${ORDER_ID}`), linkedSum: 246000 }],
    });
    expect(ref).toEqual({
      externalId: paymentIn.id,
      number: '00087',
      url: `https://online.moysklad.ru/app/#paymentin/edit?id=${paymentIn.id}`,
    });
  });

  it('maps products: article or code as SKU, barcodes, the retail price and VAT', async () => {
    let query: URLSearchParams | undefined;
    server.use(
      http.get(`${BASE}/entity/product`, ({ request }) => {
        query = new URL(request.url).searchParams;
        return HttpResponse.json(products);
      }),
    );
    const result = await connector().ms.listProducts();

    expect(query?.get('limit')).toBe('1000');
    expect(query?.get('offset')).toBe('0');
    expect(result).toEqual([
      {
        externalId: ETHIOPIA,
        sku: 'ZP-ETH-250',
        barcodes: ['4607012345674', 'ZPETH250'],
        name: 'Кофе в зёрнах Эфиопия Иргачеффе, 250 г',
        priceMinor: 74900,
        vatRatePercent: 22,
        archived: false,
      },
      {
        externalId: FILTERS,
        sku: 'ZP-V60-FLT-W',
        barcodes: [],
        name: 'Фильтры бумажные для V60, белые, 100 шт',
        priceMinor: 49000,
        vatRatePercent: null,
        archived: false,
      },
      {
        externalId: '8f1c2a10-5b2e-11f1-0a80-0d6a00145e48',
        sku: null,
        barcodes: [],
        name: 'Кофе в зёрнах Колумбия Супремо, 1 кг',
        priceMinor: null,
        vatRatePercent: 10,
        archived: true,
      },
    ]);
  });

  it('reads available stock from the light stock reports', async () => {
    const queries: Record<string, URLSearchParams> = {};
    server.use(
      http.get(`${BASE}/report/stock/all/current`, ({ request }) => {
        queries.all = new URL(request.url).searchParams;
        return HttpResponse.json([
          { assortmentId: ETHIOPIA, quantity: 14 },
          { assortmentId: FILTERS, quantity: 0 },
        ]);
      }),
      http.get(`${BASE}/report/stock/bystore/current`, ({ request }) => {
        queries.byStore = new URL(request.url).searchParams;
        return HttpResponse.json([
          { assortmentId: ETHIOPIA, storeId: STORE, quantity: 6.5 },
          { assortmentId: FILTERS, storeId: STORE, quantity: -2 },
        ]);
      }),
    );
    const { ms } = connector();

    expect(await ms.getStock(null)).toEqual([
      { productExternalId: ETHIOPIA, available: 14 },
      { productExternalId: FILTERS, available: 0 },
    ]);
    expect(await ms.getStock(STORE)).toEqual([
      { productExternalId: ETHIOPIA, available: 6 },
      { productExternalId: FILTERS, available: 0 },
    ]);
    expect(queries.all?.get('stockType')).toBe('quantity');
    expect(queries.all?.get('include')).toBe('zeroLines');
    expect(queries.all?.has('filter')).toBe(false);
    expect(queries.byStore?.get('filter')).toBe(`storeId=${STORE}`);
  });

  it('lists warehouses, order states and VAT rates', async () => {
    server.use(
      http.get(`${BASE}/entity/store`, () =>
        HttpResponse.json(list([{ id: STORE, name: 'Склад на Лиговском' }])),
      ),
      http.get(`${BASE}/entity/customerorder/metadata`, () =>
        HttpResponse.json({
          states: [
            { id: STATE, name: 'Новый', stateType: 'Regular' },
            { id: '1d4e5f60-5b2e-11f1-0a80-0d6a00130021', name: 'Отгружен', stateType: 'Successful' },
          ],
        }),
      ),
      http.get(`${BASE}/entity/taxrate`, () =>
        HttpResponse.json(
          list([
            { id: 't1', rate: 22, comment: 'НДС 22%' },
            { id: 't2', rate: 10 },
            { id: 't3', rate: 20, archived: true },
          ]),
        ),
      ),
    );
    const { ms } = connector();

    expect(await ms.listWarehouses()).toEqual([{ externalId: STORE, name: 'Склад на Лиговском' }]);
    expect(await ms.listOrderStatuses()).toEqual([
      { externalId: STATE, name: 'Новый' },
      { externalId: '1d4e5f60-5b2e-11f1-0a80-0d6a00130021', name: 'Отгружен' },
    ]);
    expect(await ms.listTaxRates()).toEqual([
      { code: '22', name: 'НДС 22%', ratePercent: 22 },
      { code: '10', name: 'НДС 10%', ratePercent: 10 },
      { code: 'none', name: 'Без НДС', ratePercent: 0 },
    ]);
  });

  it('turns MoySklad errors into typed sync errors', async () => {
    server.use(
      http.get(`${BASE}/entity/customerorder`, () =>
        HttpResponse.json(
          {
            errors: [
              {
                error: 'Превышено ограничение на количество запросов в единицу времени',
                code: 1049,
                moreInfo: 'https://dev.moysklad.ru/doc/api/remap/1.2/#error_1049',
              },
            ],
          },
          { status: 429, headers: { 'x-lognex-retry-after': '1850', 'x-lognex-retry-timeinterval': '3000' } },
        ),
      ),
      http.post(`${BASE}/entity/customerorder`, () =>
        HttpResponse.json(
          {
            errors: [
              { error: "Ошибка формата: значение поля 'agent' не соответствует типу", code: 2016 },
              { error: 'Поле организация не может быть пустым', code: 3000 },
            ],
          },
          { status: 412 },
        ),
      ),
      http.get(`${BASE}/entity/store`, () => new HttpResponse(null, { status: 429 })),
    );
    const { ms } = connector({ deliveryServiceId: DELIVERY });

    const limited = await ms.findSalesDocument('woocommerce:4127').catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(RateLimitedError);
    expect((limited as RateLimitedError).retryAfterMs).toBe(1850);
    expect((limited as RateLimitedError).detail).toContain('(1049)');

    const rejected = await ms.createSalesDocument(orderInput).catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(ValidationRejectedError);
    expect((rejected as ValidationRejectedError).detail).toBe(
      "Ошибка формата: значение поля 'agent' не соответствует типу (2016); Поле организация не может быть пустым (3000)",
    );

    const bare = await ms.listWarehouses().catch((e: unknown) => e);
    expect((bare as RateLimitedError).retryAfterMs).toBe(3000);
  });

  it('checks the secret from the delivery URL and keys events by requestId', () => {
    const { ms } = connector();
    const rawBody = Buffer.from(JSON.stringify(productWebhook));
    const query = { secret: 'ms_hook_5d1e', requestId: '640569eb-522d-427a-b07e-fa757c5d4217' };

    expect(ms.verifyWebhook({ headers: {}, query, rawBody }, 'ms_hook_5d1e')).toBe(true);
    expect(ms.verifyWebhook({ headers: {}, query, rawBody }, 'other')).toBe(false);
    expect(ms.verifyWebhook({ headers: {}, rawBody }, 'ms_hook_5d1e')).toBe(false);

    expect(ms.parseWebhook({ headers: {}, query, rawBody })).toEqual([
      { topic: 'product.updated', deliveryId: `${query.requestId}:0`, entityId: ETHIOPIA },
      {
        topic: 'product.created',
        deliveryId: `${query.requestId}:1`,
        entityId: '8f1c2a10-5b2e-11f1-0a80-0d6a00145e99',
      },
    ]);
  });

  it('turns a stock webhook into a single stock.changed event', () => {
    const rawBody = Buffer.from(
      JSON.stringify({
        accountId: 'f71cb8b6-f7b5-11ec-ac12-000f000000eb',
        stockType: 'stock',
        reportType: 'all',
        reportUrl: `${BASE}/report/stock/all/current?changedSince=2026-10-18 14:00:12`,
      }),
    );
    const events = connector().ms.parseWebhook({
      headers: {},
      query: { secret: 'ms_hook_5d1e', requestId: 'b3c1f0aa-7d2e-4e55-9c1b-2f0e6a9d8c71' },
      rawBody,
    });
    expect(events).toEqual([
      { topic: 'stock.changed', deliveryId: 'b3c1f0aa-7d2e-4e55-9c1b-2f0e6a9d8c71', entityId: null },
    ]);
  });
});
