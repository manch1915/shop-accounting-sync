import { ZERNO_PRODUCTS } from '@sas/demo-data';
import { describe, expect, it } from 'vitest';
import {
  AuthError,
  ProviderUnavailableError,
  RateLimitedError,
  ValidationRejectedError,
} from '../../../api/src/domain/errors.js';
import type { Customer, SalesDocumentInput } from '../../../api/src/domain/models.js';
import { MOYSKLAD } from '../ids.js';
import { harness, TEST_TOKEN, TEST_URL } from '../testing/harness.js';
import { moyskladProductWebhook, moyskladStockWebhook } from '../webhooks.js';

const customer: Customer = {
  matchKey: 'woo-c87',
  externalId: '87',
  email: 'm.kotova@example.ru',
  phone: '+79110000001',
  firstName: 'Марина',
  lastName: 'Котова',
  company: null,
  address: {
    line1: 'ул. Рубинштейна, 12, кв. 5',
    line2: null,
    city: 'Санкт-Петербург',
    postcode: '191002',
    region: null,
    country: 'RU',
  },
};

describe('МойСклад sandbox against the API connector', () => {
  it('lists products with articles, barcodes, retail prices and VAT', async () => {
    const products = await harness().moysklad().listProducts();

    expect(products).toHaveLength(ZERNO_PRODUCTS.filter((p) => !p.storeOnly).length);
    expect(products.find((p) => p.sku === 'Ч-0412')).toMatchObject({
      name: 'Чайник с гусиным носиком, 1 л',
      barcodes: ['4607012340172'],
      priceMinor: 389_000,
      vatRatePercent: 22,
      archived: false,
    });
    expect(products.find((p) => p.sku === 'ZP-GIFT-3000')?.vatRatePercent).toBeNull();
    expect(products.some((p) => p.sku === 'ZP-MUG-ENAMEL')).toBe(false);
    expect(products.some((p) => p.sku === 'ZP-RWA-250')).toBe(true);
  });

  it('reports stock in total and per warehouse', async () => {
    const ms = harness().moysklad();
    const all = await ms.getStock(null);
    const main = await ms.getStock(MOYSKLAD.mainStoreId);
    const cafe = await ms.getStock(MOYSKLAD.cafeStoreId);
    const products = await ms.listProducts();
    const idOf = (sku: string) => products.find((p) => p.sku === sku)?.externalId;

    expect(all).toHaveLength(ZERNO_PRODUCTS.filter((p) => !p.storeOnly && !p.untracked).length);
    expect(all.find((s) => s.productExternalId === idOf('ZP-BRA-250'))?.available).toBe(64);
    const mainBra = main.find((s) => s.productExternalId === idOf('ZP-BRA-250'))?.available ?? 0;
    const cafeBra = cafe.find((s) => s.productExternalId === idOf('ZP-BRA-250'))?.available ?? 0;
    expect(mainBra + cafeBra).toBe(64);
    expect(cafeBra).toBeGreaterThan(0);
    expect(all.some((s) => s.productExternalId === idOf('ZP-GIFT-3000'))).toBe(false);
  });

  it('lists warehouses, order states and VAT rates', async () => {
    const ms = harness().moysklad();
    expect((await ms.listWarehouses()).map((w) => w.name)).toEqual([
      'Основной склад',
      'Кофейня на Рубинштейна',
    ]);
    expect((await ms.listOrderStatuses()).map((s) => s.name)).toEqual([
      'Новый',
      'Подтверждён',
      'Собран',
      'Отгружен',
      'Доставлен',
      'Отменён',
    ]);
    expect((await ms.listTaxRates()).map((r) => r.code)).toEqual(['0', '10', '22', 'none']);
  });

  it('finds a counterparty by our key instead of creating a second one', async () => {
    const ms = harness().moysklad();
    const first = await ms.upsertCustomer(customer);
    expect(await ms.upsertCustomer(customer)).toBe(first);
    expect(await ms.upsertCustomer({ ...customer, matchKey: 'woo-o40001', externalId: null })).not.toBe(
      first,
    );
  });

  it('creates a customer order, finds it by externalCode and links a payment', async () => {
    const h = harness();
    const ms = h.moysklad();
    const products = await ms.listProducts();
    const idOf = (sku: string) => products.find((p) => p.sku === sku)?.externalId ?? '';
    const agent = await ms.upsertCustomer(customer);
    const [state] = await ms.listOrderStatuses();
    const input: SalesDocumentInput = {
      externalRef: 'woo-41250',
      number: 'WEB-41250',
      date: new Date('2026-10-19T09:14:03Z'),
      currency: 'RUB',
      customerId: agent,
      lines: [
        {
          accountingProductId: idOf('ZP-ETH-250'),
          name: 'Эфиопия Иргачеффе, 250 г',
          quantity: 2,
          unitPriceMinor: 74_900,
          discountPercent: 10,
          taxCode: '22',
          taxRatePercent: 22,
        },
        {
          accountingProductId: idOf('ZP-GIFT-3000'),
          name: 'Подарочный сертификат на 3000 ₽',
          quantity: 1,
          unitPriceMinor: 300_000,
          discountPercent: 0,
          taxCode: 'none',
          taxRatePercent: 0,
        },
      ],
      shipping: { name: 'Курьер по городу', priceMinor: 29_000, taxCode: '22', taxRatePercent: 22 },
      pricesIncludeTax: true,
      warehouseId: MOYSKLAD.mainStoreId,
      statusId: state?.externalId ?? null,
      comment: 'Позвонить за час до доставки',
    };

    expect(await ms.findSalesDocument('woo-41250')).toBeNull();
    const doc = await ms.createSalesDocument(input);
    expect(doc.number).toBe('WEB-41250');
    expect(await ms.findSalesDocument('woo-41250')).toEqual(doc);

    const stored = h.sandbox.state.moysklad.orders.get(doc.externalId);
    // 2 × 749 − 10% + 3000 + 290 delivery, VAT included
    expect(stored).toMatchObject({
      sum: 134_820 + 300_000 + 29_000,
      vatIncluded: true,
      positions: { length: 3 },
    });
    expect(stored?.vatSum).toBe(24_312 + 5_230);
    expect(h.sandbox.state.moysklad.services.size).toBe(1);

    const payment = await ms.registerPayment({
      document: doc,
      customerId: agent,
      amountMinor: 463_820,
      currency: 'RUB',
      paidAt: new Date('2026-10-19T09:15:00Z'),
      reference: 'ЮKassa 2f9a1c7e',
    });
    expect(payment.number).toBe('00001');
    expect(h.sandbox.state.moysklad.orders.get(doc.externalId)?.payedSum).toBe(463_820);

    await expect(
      ms.createSalesDocument({
        ...input,
        externalRef: 'woo-41251',
        lines: [{ ...input.lines[0], accountingProductId: 'nope' } as never],
      }),
    ).rejects.toBeInstanceOf(ValidationRejectedError);
  });

  it('sends webhooks the connector accepts', () => {
    const ms = harness().moysklad();
    const stock = moyskladStockWebhook(TEST_TOKEN, TEST_URL, new Date());
    const stockHook = { headers: stock.headers, query: stock.query, rawBody: Buffer.from(stock.body) };
    expect(ms.verifyWebhook(stockHook, TEST_TOKEN)).toBe(true);
    expect(ms.parseWebhook(stockHook)).toEqual([
      { topic: 'stock.changed', deliveryId: stock.deliveryId, entityId: null },
    ]);

    const price = moyskladProductWebhook(TEST_TOKEN, TEST_URL, [MOYSKLAD.organizationId]);
    const priceHook = { headers: price.headers, query: price.query, rawBody: Buffer.from(price.body) };
    expect(ms.parseWebhook(priceHook)).toEqual([
      { topic: 'product.updated', deliveryId: `${price.deliveryId}:0`, entityId: MOYSKLAD.organizationId },
    ]);
  });

  it('answers a bad token with 401 and injects 429 and 503 when asked to', async () => {
    await expect(harness().moysklad({ token: 'wrong' }).listWarehouses()).rejects.toBeInstanceOf(AuthError);

    const flaky = harness({ faultRate: 1 }).moysklad();
    const errors = await Promise.all(
      Array.from({ length: 12 }, () => flaky.listWarehouses().catch((e: unknown) => e)),
    );
    expect(errors.every((e) => e instanceof RateLimitedError || e instanceof ProviderUnavailableError)).toBe(
      true,
    );
    const limited = errors.find((e): e is RateLimitedError => e instanceof RateLimitedError);
    expect(limited?.retryAfterMs).toBeGreaterThanOrEqual(1500);
    expect(limited?.retryAfterMs).toBeLessThanOrEqual(4000);
    expect(errors.some((e) => e instanceof ProviderUnavailableError)).toBe(true);
  });
});
