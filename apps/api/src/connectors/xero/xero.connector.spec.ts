import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { testHttp } from '../../../test/support/journal.js';
import type { Credentials } from '../../domain/connectors.js';
import { AuthError, type RateLimitedError, ValidationRejectedError } from '../../domain/errors.js';
import type { Customer, SalesDocumentInput } from '../../domain/models.js';
import { hmacSha256 } from '../../security/hmac.js';
import duplicateName from './__fixtures__/contact-duplicate-error.json' with { type: 'json' };
import invoice from './__fixtures__/invoice.json' with { type: 'json' };
import invoiceRejected from './__fixtures__/invoice-validation-error.json' with { type: 'json' };
import items from './__fixtures__/items.json' with { type: 'json' };
import taxRates from './__fixtures__/tax-rates.json' with { type: 'json' };
import { XeroConnector, xeroErrorPolicy } from './xero.connector.js';

const BASE = 'https://api.xero.test/api.xro/2.0';
const IDENTITY = 'https://identity.xero.test';
const TENANT = 'a3f5c1e2-7b9d-4c8e-b6a4-1f2e3d4c5b6a';
const CONTACT_ID = 'b8e1c2d3-5f4a-4e6b-9c7d-2a1b0c9d8e7f';
const INVOICE_ID = invoice.Invoices[0]?.InvoiceID ?? '';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function connector(credentials: Partial<Credentials> = {}, settings: Record<string, unknown> = {}) {
  const { http: client, records } = testHttp('xero', BASE, xeroErrorPolicy);
  const onCredentialsRefreshed = vi.fn(async (_c: Credentials, _e: Date | null) => {});
  const xero = new XeroConnector({
    connectionId: 'conn_test',
    baseUrl: BASE,
    credentials: {
      accessToken: 'xero_access_old',
      refreshToken: 'xero_refresh_old',
      clientId: 'HT_CLIENT_ID',
      clientSecret: 'ht_client_secret',
      tenantId: TENANT,
      expiresAt: new Date(Date.now() + 25 * 60_000).toISOString(),
      ...credentials,
    } as Credentials,
    settings: { identityUrl: IDENTITY, currency: 'GBP', dueDays: 7, ...settings },
    http: client,
    onCredentialsRefreshed,
  });
  return { xero, records, onCredentialsRefreshed };
}

const order: SalesDocumentInput = {
  externalRef: 'shopify:6012345678901',
  number: '1042',
  date: new Date('2026-10-18T09:14:03Z'),
  currency: 'GBP',
  customerId: CONTACT_ID,
  lines: [
    {
      accountingProductId: 'HT-EARLGREY-100',
      name: 'Earl Grey Loose Leaf, 100 g',
      quantity: 2,
      unitPriceMinor: 895,
      discountPercent: 10,
      taxCode: 'OUTPUT2',
      taxRatePercent: 20,
    },
    {
      accountingProductId: 'HT-DARJ-FF-50',
      name: 'Darjeeling First Flush, 50 g',
      quantity: 1,
      unitPriceMinor: 1250,
      discountPercent: 0,
      taxCode: 'OUTPUT2',
      taxRatePercent: 20,
    },
  ],
  shipping: { name: 'Royal Mail Tracked 48', priceMinor: 395, taxCode: 'OUTPUT2', taxRatePercent: 20 },
  pricesIncludeTax: false,
  warehouseId: null,
  statusId: null,
  comment: null,
};

const customer: Customer = {
  matchKey: 'shop-c7001',
  externalId: '7781',
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

describe('XeroConnector', () => {
  it('creates an ACCREC invoice with item codes, discounts, tax types and a shipping line', async () => {
    let body: unknown;
    let headers: Headers | undefined;
    server.use(
      http.put(`${BASE}/Invoices`, async ({ request }) => {
        headers = request.headers;
        body = await request.json();
        return HttpResponse.json(invoice);
      }),
    );
    const { xero, records } = connector();
    const ref = await xero.createSalesDocument(order);

    expect(headers?.get('authorization')).toBe('Bearer xero_access_old');
    expect(headers?.get('xero-tenant-id')).toBe(TENANT);
    expect(headers?.get('idempotency-key')).toMatch(/^invoice:shopify:6012345678901:[0-9a-f]{16}$/);
    expect(records[0]?.requestHeaders.authorization).not.toContain('access_old');
    expect(body).toEqual({
      Invoices: [
        {
          Type: 'ACCREC',
          Contact: { ContactID: CONTACT_ID },
          Date: '2026-10-18',
          DueDate: '2026-10-25',
          LineAmountTypes: 'Exclusive',
          Reference: 'shopify:6012345678901',
          InvoiceNumber: 'WEB-1042',
          CurrencyCode: 'GBP',
          Status: 'AUTHORISED',
          LineItems: [
            {
              ItemCode: 'HT-EARLGREY-100',
              Description: 'Earl Grey Loose Leaf, 100 g',
              Quantity: 2,
              UnitAmount: 8.95,
              DiscountRate: 10,
              TaxType: 'OUTPUT2',
              AccountCode: '200',
            },
            {
              ItemCode: 'HT-DARJ-FF-50',
              Description: 'Darjeeling First Flush, 50 g',
              Quantity: 1,
              UnitAmount: 12.5,
              TaxType: 'OUTPUT2',
              AccountCode: '200',
            },
            {
              Description: 'Royal Mail Tracked 48',
              Quantity: 1,
              UnitAmount: 3.95,
              TaxType: 'OUTPUT2',
              AccountCode: '200',
            },
          ],
        },
      ],
    });
    expect(ref).toEqual({
      externalId: INVOICE_ID,
      number: 'WEB-1042',
      url: `https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${INVOICE_ID}`,
    });
  });

  it('respects invoice settings and inclusive prices', async () => {
    let body: { Invoices: Array<Record<string, unknown> & { LineItems: Array<Record<string, unknown>> }> } = {
      Invoices: [],
    };
    server.use(
      http.put(`${BASE}/Invoices`, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return HttpResponse.json(invoice);
      }),
    );
    const { xero } = connector(
      {},
      { invoicePrefix: 'HT-', invoiceStatus: 'DRAFT', shippingAccountCode: '260', dueDays: 0 },
    );
    await xero.createSalesDocument({ ...order, pricesIncludeTax: true });

    expect(body.Invoices[0]).toMatchObject({
      InvoiceNumber: 'HT-1042',
      Status: 'DRAFT',
      LineAmountTypes: 'Inclusive',
      DueDate: '2026-10-18',
    });
    expect(body.Invoices[0]?.LineItems.at(-1)?.AccountCode).toBe('260');
  });

  it('rejects an invoice when Xero returns validation errors', async () => {
    server.use(
      http.put(`${BASE}/Invoices`, () => HttpResponse.json(invoiceRejected, { status: 400 })),
      http.put(`${BASE}/Payments`, () =>
        HttpResponse.json({
          Payments: [
            {
              PaymentID: '00000000-0000-0000-0000-000000000000',
              HasValidationErrors: true,
              ValidationErrors: [
                { Message: 'Payment amount exceeds the amount outstanding on this document' },
              ],
            },
          ],
        }),
      ),
    );
    const { xero } = connector();

    const rejected = await xero.createSalesDocument(order).catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(ValidationRejectedError);
    expect((rejected as ValidationRejectedError).detail).toBe(
      "Item code 'HT-ASSAM-250' is not valid; The TaxType code 'OUTPUT9' does not exist or cannot be used for this type of transaction.",
    );

    const overpaid = await xero
      .registerPayment({
        document: { externalId: INVOICE_ID, number: 'WEB-1042', url: null },
        customerId: CONTACT_ID,
        amountMinor: 999_00,
        currency: 'GBP',
        paidAt: new Date('2026-10-18T09:15:00Z'),
        reference: 'pi_3QhT7a',
      })
      .catch((e: unknown) => e);
    expect((overpaid as ValidationRejectedError).detail).toBe(
      'Payment amount exceeds the amount outstanding on this document',
    );
  });

  it('finds a live invoice by Reference and ignores voided ones', async () => {
    const queries: URLSearchParams[] = [];
    server.use(
      http.get(`${BASE}/Invoices`, ({ request }) => {
        const query = new URL(request.url).searchParams;
        queries.push(query);
        const live = invoice.Invoices[0];
        return HttpResponse.json({
          Invoices: query.get('where')?.includes('6012345678901')
            ? [{ ...live, InvoiceID: 'voided-one', Status: 'VOIDED' }, live]
            : [{ ...live, Status: 'DELETED' }],
        });
      }),
    );
    const { xero } = connector();

    expect(await xero.findSalesDocument('shopify:6012345678901')).toMatchObject({
      externalId: INVOICE_ID,
      number: 'WEB-1042',
    });
    expect(await xero.findSalesDocument('shopify:6012345678999')).toBeNull();
    expect(queries[0]?.get('where')).toBe('Type=="ACCREC" AND Reference=="shopify:6012345678901"');
    expect(queries[0]?.get('summaryOnly')).toBe('true');
  });

  it('reuses only a contact carrying our ContactNumber, never one matched by email', async () => {
    let where: string | null = null;
    server.use(
      http.get(`${BASE}/Contacts`, ({ request }) => {
        where = new URL(request.url).searchParams.get('where');
        return HttpResponse.json({
          Contacts: [{ ContactID: CONTACT_ID, Name: 'Eleanor Whitfield', ContactNumber: 'shop-c7001' }],
        });
      }),
    );
    expect(await connector().xero.upsertCustomer(customer)).toBe(CONTACT_ID);
    expect(where).toBe('ContactNumber=="shop-c7001"');
  });

  it('refuses a customer without a key', async () => {
    await expect(connector().xero.upsertCustomer({ ...customer, matchKey: undefined })).rejects.toThrow(
      /matchKey/,
    );
  });

  it('creates a contact and retries with the email when the name is taken', async () => {
    const bodies: Array<{ Contacts: Array<Record<string, unknown>> }> = [];
    const keys: Array<string | null> = [];
    server.use(
      http.get(`${BASE}/Contacts`, () => HttpResponse.json({ Contacts: [] })),
      http.put(`${BASE}/Contacts`, async ({ request }) => {
        keys.push(request.headers.get('idempotency-key'));
        bodies.push((await request.json()) as (typeof bodies)[number]);
        if (bodies.length === 1) return HttpResponse.json(duplicateName, { status: 400 });
        return HttpResponse.json({ Contacts: [{ ContactID: 'c0ffee00-1111-4222-8333-444455556666' }] });
      }),
    );
    const id = await connector().xero.upsertCustomer({
      ...customer,
      email: 'tom.baker@example.co.uk',
      firstName: 'Thomas',
      lastName: 'Baker',
    });

    expect(id).toBe('c0ffee00-1111-4222-8333-444455556666');
    expect(bodies[0]?.Contacts[0]).toEqual({
      Name: 'Thomas Baker',
      ContactNumber: 'shop-c7001',
      FirstName: 'Thomas',
      LastName: 'Baker',
      EmailAddress: 'tom.baker@example.co.uk',
      Phones: [{ PhoneType: 'MOBILE', PhoneNumber: '+447700900123' }],
      Addresses: [
        {
          AddressType: 'STREET',
          AddressLine1: '14 Orchard Lane',
          City: 'Harrogate',
          PostalCode: 'HG1 2QX',
          Region: 'North Yorkshire',
          Country: 'GB',
        },
      ],
    });
    expect(bodies[1]?.Contacts[0]?.Name).toBe('Thomas Baker (tom.baker@example.co.uk)');
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('records a payment against the invoice', async () => {
    let body: unknown;
    let key: string | null = null;
    server.use(
      http.put(`${BASE}/Payments`, async ({ request }) => {
        key = request.headers.get('idempotency-key');
        body = await request.json();
        return HttpResponse.json({
          Payments: [{ PaymentID: '9d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d', Reference: 'pi_3QhT7a' }],
        });
      }),
    );
    const { xero } = connector({}, { paymentAccountCode: '091' });
    const ref = await xero.registerPayment({
      document: { externalId: INVOICE_ID, number: 'WEB-1042', url: null },
      customerId: CONTACT_ID,
      amountMinor: 4518,
      currency: 'GBP',
      paidAt: new Date('2026-10-18T09:15:00Z'),
      reference: 'pi_3QhT7a',
    });

    expect(body).toEqual({
      Payments: [
        {
          Invoice: { InvoiceID: INVOICE_ID },
          Account: { Code: '091' },
          Date: '2026-10-18',
          Amount: 45.18,
          Reference: 'pi_3QhT7a',
        },
      ],
    });
    expect(key).toMatch(/^payment:pi_3QhT7a:/);
    expect(ref).toEqual({
      externalId: '9d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
      number: null,
      url: `https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${INVOICE_ID}`,
    });
  });

  it('maps items to products and tracked stock, and lists revenue tax rates', async () => {
    server.use(
      http.get(`${BASE}/Items`, () => HttpResponse.json(items)),
      http.get(`${BASE}/TaxRates`, () => HttpResponse.json(taxRates)),
    );
    const { xero } = connector();

    expect((await xero.listProducts()).slice(0, 2)).toEqual([
      {
        externalId: 'HT-EARLGREY-100',
        sku: 'HT-EARLGREY-100',
        barcodes: [],
        name: 'Earl Grey Loose Leaf, 100 g',
        priceMinor: 895,
        vatRatePercent: null,
        archived: false,
      },
      {
        externalId: 'HT-DARJ-FF-50',
        sku: 'HT-DARJ-FF-50',
        barcodes: [],
        name: 'Darjeeling First Flush, 50 g',
        priceMinor: 1250,
        vatRatePercent: null,
        archived: false,
      },
    ]);
    expect((await xero.listProducts()).at(-1)?.priceMinor).toBeNull();
    expect(await xero.getStock('ignored')).toEqual([
      { productExternalId: 'HT-EARLGREY-100', available: 42 },
      { productExternalId: 'HT-DARJ-FF-50', available: 7 },
      { productExternalId: 'HT-TEAPOT-CAST', available: 0 },
    ]);
    expect(await xero.listTaxRates()).toEqual([
      { code: 'OUTPUT2', name: '20% (VAT on Income)', ratePercent: 20 },
      { code: 'RROUTPUT', name: '5% (VAT on Income)', ratePercent: 5 },
      { code: 'ZERORATEDOUTPUT', name: 'Zero Rated Income', ratePercent: 0 },
    ]);
  });

  it('refreshes an expiring token before the call and reports the new credentials', async () => {
    let tokenRequest: { auth: string | null; form: URLSearchParams } | undefined;
    let apiAuth: string | null = null;
    server.use(
      http.post(`${IDENTITY}/connect/token`, async ({ request }) => {
        tokenRequest = {
          auth: request.headers.get('authorization'),
          form: new URLSearchParams(await request.text()),
        };
        return HttpResponse.json({
          access_token: 'xero_access_new',
          refresh_token: 'xero_refresh_new',
          expires_in: 1800,
          token_type: 'Bearer',
        });
      }),
      http.get(`${BASE}/TaxRates`, ({ request }) => {
        apiAuth = request.headers.get('authorization');
        return HttpResponse.json(taxRates);
      }),
    );
    const { xero, records, onCredentialsRefreshed } = connector({
      expiresAt: new Date(Date.now() + 20_000).toISOString(),
    });
    await xero.listTaxRates();

    expect(tokenRequest?.auth).toBe(
      `Basic ${Buffer.from('HT_CLIENT_ID:ht_client_secret').toString('base64')}`,
    );
    expect(tokenRequest?.form.get('grant_type')).toBe('refresh_token');
    expect(tokenRequest?.form.get('refresh_token')).toBe('xero_refresh_old');
    expect(apiAuth).toBe('Bearer xero_access_new');
    expect(onCredentialsRefreshed).toHaveBeenCalledOnce();
    const [credentials, expiresAt] = onCredentialsRefreshed.mock.calls[0] ?? [];
    expect(credentials).toMatchObject({
      accessToken: 'xero_access_new',
      refreshToken: 'xero_refresh_new',
      tenantId: TENANT,
    });
    expect(expiresAt?.getTime()).toBeGreaterThan(Date.now() + 29 * 60_000);
    expect(records[0]?.requestBody).not.toContain('xero_refresh_old');

    await xero.listTaxRates();
    expect(onCredentialsRefreshed).toHaveBeenCalledOnce();
  });

  it('refreshes once on 401 and repeats the request', async () => {
    const seen: Array<string | null> = [];
    let refreshes = 0;
    server.use(
      http.post(`${IDENTITY}/connect/token`, () => {
        refreshes += 1;
        return HttpResponse.json({ access_token: 'xero_access_new', expires_in: 1800, token_type: 'Bearer' });
      }),
      http.get(`${BASE}/Items`, ({ request }) => {
        const auth = request.headers.get('authorization');
        seen.push(auth);
        if (auth !== 'Bearer xero_access_new') {
          return HttpResponse.json(
            {
              Type: null,
              Title: 'Unauthorized',
              Status: 401,
              Detail: 'TokenExpired: token expired at 10/18/2026 09:00:00',
            },
            { status: 401 },
          );
        }
        return HttpResponse.json(items);
      }),
    );
    const { xero, onCredentialsRefreshed } = connector();
    const stock = await xero.getStock(null);

    expect(stock).toHaveLength(3);
    expect(seen).toEqual(['Bearer xero_access_old', 'Bearer xero_access_new']);
    expect(refreshes).toBe(1);
    expect(onCredentialsRefreshed.mock.calls[0]?.[0]).toMatchObject({ refreshToken: 'xero_refresh_old' });
  });

  it('turns a rejected refresh into an auth error', async () => {
    server.use(
      http.post(`${IDENTITY}/connect/token`, () =>
        HttpResponse.json({ error: 'invalid_grant' }, { status: 400 }),
      ),
    );
    const { xero, onCredentialsRefreshed } = connector({
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const err = await xero.listTaxRates().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).detail).toBe('token refresh failed: invalid_grant');
    expect(onCredentialsRefreshed).not.toHaveBeenCalled();
  });

  it('reads Retry-After on 429', async () => {
    server.use(
      http.get(`${BASE}/TaxRates`, () =>
        HttpResponse.json(
          { Title: 'Too Many Requests', Status: 429 },
          { status: 429, headers: { 'retry-after': '23', 'x-rate-limit-problem': 'minute' } },
        ),
      ),
    );
    const err = await connector()
      .xero.listTaxRates()
      .catch((e: unknown) => e);
    expect((err as RateLimitedError).retryAfterMs).toBe(23_000);
  });

  it('verifies the signature and answers intent to receive', () => {
    const { xero } = connector();
    const rawBody = Buffer.from(
      JSON.stringify({
        events: [],
        firstEventSequence: 0,
        lastEventSequence: 0,
        entropy: 'QWERTYUIOPASDFGH',
      }),
    );
    const headers = { 'x-xero-signature': hmacSha256('xero_webhook_key', rawBody) };

    expect(xero.verifyWebhook({ headers, rawBody }, 'xero_webhook_key')).toBe(true);
    expect(xero.verifyWebhook({ headers, rawBody }, 'wrong_key')).toBe(false);
    expect(xero.verifyWebhook({ headers: {}, rawBody }, 'xero_webhook_key')).toBe(false);

    const [ping] = xero.parseWebhook({ headers, rawBody });
    expect(ping).toMatchObject({ topic: 'ping', entityId: null });
    expect(ping?.deliveryId).toMatch(/^itr-[0-9a-f]{32}$/);

    const invoiceEvent = Buffer.from(
      JSON.stringify({
        events: [
          {
            resourceUrl: `${BASE}/Invoices/${INVOICE_ID}`,
            resourceId: INVOICE_ID,
            eventDateUtc: '2026-10-18T09:16:02.117',
            eventType: 'UPDATE',
            eventCategory: 'INVOICE',
            tenantId: TENANT,
            tenantType: 'ORGANISATION',
          },
        ],
        firstEventSequence: 3,
        lastEventSequence: 3,
        entropy: 'ZXCVBNMLKJHGFDSA',
      }),
    );
    expect(xero.parseWebhook({ headers: {}, rawBody: invoiceEvent })).toEqual([]);
  });
});
