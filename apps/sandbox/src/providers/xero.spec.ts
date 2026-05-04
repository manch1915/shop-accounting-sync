import { HILLSIDE_PRODUCTS, SANDBOX_PATHS } from '@sas/demo-data';
import { describe, expect, it, vi } from 'vitest';
import {
  ProviderUnavailableError,
  RateLimitedError,
  ValidationRejectedError,
} from '../../../api/src/domain/errors.js';
import type { Customer, SalesDocumentInput } from '../../../api/src/domain/models.js';
import { XERO } from '../ids.js';
import { harness, TEST_TOKEN, TEST_URL } from '../testing/harness.js';

const customer: Customer = {
  matchKey: 'shop-c7712345601',
  externalId: '7712345601',
  email: 'eleanor.whitfield@example.co.uk',
  phone: '+447700900123',
  firstName: 'Eleanor',
  lastName: 'Whitfield',
  company: null,
  address: {
    line1: '14 Orchard Lane',
    line2: null,
    city: 'Harrogate',
    postcode: 'HG1 2QX',
    region: 'North Yorkshire',
    country: 'GB',
  },
};

function invoiceInput(customerId: string, overrides: Partial<SalesDocumentInput> = {}): SalesDocumentInput {
  return {
    externalRef: 'shop-6100000041250',
    number: '41250',
    date: new Date('2026-10-19T10:22:38Z'),
    currency: 'GBP',
    customerId,
    lines: [
      {
        accountingProductId: 'HT-EGL-100',
        name: 'Earl Grey Lavender, loose leaf 100 g',
        quantity: 2,
        unitPriceMinor: 746,
        discountPercent: 10,
        taxCode: 'OUTPUT2',
        taxRatePercent: 20,
      },
      {
        accountingProductId: 'HT-HONEY-WLD',
        name: 'Wildflower honey, 340 g',
        quantity: 1,
        unitPriceMinor: 850,
        discountPercent: 0,
        taxCode: 'ZERORATEDOUTPUT',
        taxRatePercent: 0,
      },
    ],
    shipping: { name: 'Royal Mail Tracked 48', priceMinor: 329, taxCode: 'OUTPUT2', taxRatePercent: 20 },
    pricesIncludeTax: false,
    warehouseId: null,
    statusId: null,
    comment: null,
    ...overrides,
  };
}

describe('Xero sandbox against the API connector', () => {
  it('lists items by code with tracked stock, and revenue tax rates', async () => {
    const xero = harness().xero();
    const items = await xero.listProducts();
    expect(items.map((i) => i.sku).sort()).toEqual(
      HILLSIDE_PRODUCTS.filter((p) => !p.storeOnly)
        .map((p) => p.accountingSku ?? p.sku)
        .sort(),
    );
    expect(items.find((i) => i.sku === 'HT-MAT-30')).toMatchObject({
      externalId: 'HT-MAT-30',
      priceMinor: 1995,
    });
    const stock = await xero.getStock(null);
    expect(stock.find((s) => s.productExternalId === 'HT-ENB-100')?.available).toBe(120);
    expect(stock.some((s) => s.productExternalId === 'HT-GIFTCARD-25')).toBe(false);
    expect((await xero.listTaxRates()).map((r) => r.code)).toEqual([
      'OUTPUT2',
      'RROUTPUT',
      'ZERORATEDOUTPUT',
      'EXEMPTOUTPUT',
      'NONE',
    ]);
  });

  it('reuses a contact by ContactNumber and suffixes a taken name', async () => {
    const h = harness();
    const xero = h.xero();
    const id = await xero.upsertCustomer(customer);
    expect(await xero.upsertCustomer(customer)).toBe(id);

    const namesake = await xero.upsertCustomer({
      ...customer,
      matchKey: 'shop-o6100000041251',
      externalId: null,
    });
    expect(namesake).not.toBe(id);
    expect(h.sandbox.state.xero.contacts.get(namesake)?.Name).toBe('Eleanor Whitfield (shop-o6100000041251)');
  });

  it('creates an invoice once, finds it by Reference and takes a payment', async () => {
    const h = harness();
    const xero = h.xero();
    const contact = await xero.upsertCustomer(customer);
    const input = invoiceInput(contact);

    expect(await xero.findSalesDocument(input.externalRef)).toBeNull();
    const doc = await xero.createSalesDocument(input);
    expect(doc.number).toBe('WEB-41250');
    // a resend with the same body reuses the idempotency key and gets the same invoice back
    expect(await xero.createSalesDocument(input)).toEqual(doc);
    expect(await xero.findSalesDocument(input.externalRef)).toEqual(doc);
    expect(h.sandbox.state.xero.invoices.size).toBe(1);

    const invoice = h.sandbox.state.xero.invoices.get(doc.externalId);
    // 2 × 7.46 − 10% = 13.43 (+2.69 VAT), honey 8.50 at 0%, delivery 3.29 (+0.66 VAT)
    expect(invoice).toMatchObject({ subTotal: 1343 + 850 + 329, totalTax: 269 + 66, Status: 'AUTHORISED' });
    expect(h.sandbox.state.xero.items.get('HT-EGL-100')?.quantity).toBe(62);

    await xero.registerPayment({
      document: doc,
      customerId: contact,
      amountMinor: 2857,
      currency: 'GBP',
      paidAt: new Date('2026-10-19T10:23:00Z'),
      reference: 'shopify_payments 7100000001',
    });
    expect(h.sandbox.state.xero.invoices.get(doc.externalId)?.Status).toBe('PAID');
  });

  it('refuses invoices above the demo limit and never overpays or pays twice', async () => {
    const h = harness();
    const xero = h.xero();
    const contact = await xero.upsertCustomer(customer);
    const big = invoiceInput(contact, {
      externalRef: 'shop-6100000041260',
      number: '41260',
      lines: [{ ...invoiceInput(contact).lines[0], quantity: 60 } as SalesDocumentInput['lines'][number]],
    });
    const rejected = await xero.createSalesDocument(big).catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(ValidationRejectedError);
    expect((rejected as ValidationRejectedError).detail).toBe(
      'The document total exceeds the limit allowed for this demo organisation',
    );

    // the connector pays what Xero says is due, so a shop total a little above the invoice never overpays
    const doc = await xero.createSalesDocument(invoiceInput(contact));
    const invoice = h.sandbox.state.xero.invoices.get(doc.externalId);
    await xero.registerPayment({
      document: doc,
      customerId: contact,
      amountMinor: 99_999,
      currency: 'GBP',
      paidAt: new Date(),
      reference: 'x',
    });
    expect(invoice?.amountPaid).toBe(invoice?.total);

    // a second payment for the same invoice is a no-op returning the first one
    const again = await xero.registerPayment({
      document: doc,
      customerId: contact,
      amountMinor: 99_999,
      currency: 'GBP',
      paidAt: new Date(),
      reference: 'y',
    });
    expect(h.sandbox.state.xero.payments.size).toBe(1);
    expect(again.externalId).toBe([...h.sandbox.state.xero.payments.keys()][0]);
  });

  it('refreshes a rejected access token through the identity endpoint', async () => {
    const onRefresh = vi.fn(async () => {});
    const xero = harness().xero({ accessToken: 'stale-token' }, onRefresh);
    expect(await xero.listWarehouses()).toHaveLength(1);
    await xero.listTaxRates();

    expect(onRefresh).toHaveBeenCalledOnce();
    const [credentials] = (onRefresh.mock.calls[0] ?? []) as unknown as [Record<string, string>];
    expect(credentials.accessToken).not.toBe('stale-token');
    expect(credentials.refreshToken).not.toBe(TEST_TOKEN);
  });

  it('refreshes ahead of expiry and keeps accepting the previous refresh token once', async () => {
    const h = harness();
    const onRefresh = vi.fn(async () => {});
    await h.xero({ expiresAt: new Date(Date.now() + 10_000).toISOString() }, onRefresh).listTaxRates();
    expect(onRefresh).toHaveBeenCalledOnce();

    const refresh = (refreshToken: string) =>
      h.fetchImpl(`${TEST_URL}${SANDBOX_PATHS.xeroIdentity}/connect/token`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${XERO.clientId}:${TEST_TOKEN}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
      });
    const first = (await (await refresh(TEST_TOKEN)).json()) as {
      refresh_token: string;
      access_token: string;
    };
    const second = await refresh(first.refresh_token);
    expect(second.status).toBe(200);
    expect((await refresh(first.refresh_token)).status).toBe(200);
    expect(await (await refresh('made-up')).json()).toEqual({ error: 'invalid_grant' });
  });

  it('answers with 429 and 503 when faults are on', async () => {
    const xero = harness({ faultRate: 1 }).xero();
    const errors = await Promise.all(
      Array.from({ length: 12 }, () => xero.listTaxRates().catch((e: unknown) => e)),
    );
    expect(errors.every((e) => e instanceof RateLimitedError || e instanceof ProviderUnavailableError)).toBe(
      true,
    );
    const limited = errors.find((e): e is RateLimitedError => e instanceof RateLimitedError);
    expect(limited?.retryAfterMs).toBeGreaterThanOrEqual(2000);
    expect(limited?.retryAfterMs).toBeLessThanOrEqual(5000);
  });
});
