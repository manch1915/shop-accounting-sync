import { createHash } from 'node:crypto';
import type {
  AccountingConnector,
  AccountingConnectorFactory,
  ConnectorContext,
  Credentials,
} from '../../domain/connectors.js';
import { requireMatchKey } from '../../domain/customer-key.js';
import { AuthError, SyncError, ValidationRejectedError } from '../../domain/errors.js';
import type {
  CatalogProduct,
  Customer,
  DocumentRef,
  IncomingWebhook,
  NamedRef,
  PaymentInput,
  SalesDocumentInput,
  StockLevel,
  TaxRate,
  WebhookEvent,
} from '../../domain/models.js';
import { minorToNumber, toMinor } from '../../domain/money.js';
import { hmacSha256, safeEqual } from '../../security/hmac.js';
import { type ErrorPolicy, type HttpResponse, parseRetryAfter } from '../http/http-client.js';
import type {
  XeroContact,
  XeroElement,
  XeroError,
  XeroInvoice,
  XeroItem,
  XeroPayment,
  XeroTaxRate,
  XeroTokenResponse,
  XeroWebhookBody,
} from './xero.types.js';

const REFRESH_MARGIN_MS = 60_000;
const IDEMPOTENCY_KEY_MAX = 128;
const DAY_MS = 86_400_000;
const DEAD_STATUSES = new Set(['VOIDED', 'DELETED']);
const DUPLICATE_NAME = /already assigned to another contact/i;

export const xeroErrorPolicy: ErrorPolicy = {
  retryAfterMs: (headers) => parseRetryAfter(headers.get('retry-after'), 60_000),
  extractMessage: (body) => {
    try {
      const err = JSON.parse(body) as XeroError;
      const validation = (err.Elements ?? []).flatMap((e) => e.ValidationErrors ?? []).map((v) => v.Message);
      if (validation.length) return validation.join('; ');
      return err.Message ?? err.Detail ?? err.Title ?? err.error_description ?? err.error ?? null;
    } catch {
      return null;
    }
  },
};

export class XeroConnector implements AccountingConnector {
  readonly provider = 'xero' as const;
  private credentials: Credentials;
  private expiresAt: Date | null;
  private refreshing: Promise<void> | null = null;

  constructor(private readonly ctx: ConnectorContext) {
    const { accessToken, tenantId, expiresAt } = ctx.credentials;
    if (!accessToken || !tenantId) throw new Error('Xero needs accessToken and tenantId');
    this.credentials = { ...ctx.credentials };
    this.expiresAt = expiresAt ? new Date(expiresAt) : null;
    ctx.http.setHeader('authorization', `Bearer ${accessToken}`);
    ctx.http.setHeader('xero-tenant-id', tenantId);
  }

  verifyWebhook(webhook: IncomingWebhook, secret: string): boolean {
    return safeEqual(webhook.headers['x-xero-signature'], hmacSha256(secret, webhook.rawBody));
  }

  parseWebhook(webhook: IncomingWebhook): WebhookEvent[] {
    const body = JSON.parse(webhook.rawBody.toString('utf8')) as XeroWebhookBody;
    // "intent to receive": Xero only checks that we answer 200 to a good signature and 401 to a bad one
    if (body.events.length === 0) {
      return [{ topic: 'ping', deliveryId: `itr-${digest(webhook.rawBody)}`, entityId: null }];
    }
    // INVOICE and CONTACT events would only feed accounting -> shop flows, which pull on a schedule instead
    return [];
  }

  async upsertCustomer(customer: Customer): Promise<string> {
    const key = requireMatchKey(customer);
    const data = await this.call(() =>
      this.ctx.http.get<{ Contacts?: XeroContact[] }>('/Contacts', {
        query: { where: `ContactNumber==${quote(key)}` },
      }),
    );
    const found = data.Contacts?.find((c) => c.ContactNumber === key);
    if (found) return found.ContactID;

    const fullName = `${customer.firstName} ${customer.lastName}`.trim();
    const name = customer.company ?? (fullName || customer.email || customer.phone || 'Web customer');
    try {
      return await this.createContact(customer, name);
    } catch (err) {
      // Xero wants unique contact names, and two shoppers called "Tom Baker" are not rare
      const suffix = customer.email ?? customer.phone;
      if (!(err instanceof ValidationRejectedError) || !DUPLICATE_NAME.test(err.detail ?? '') || !suffix) {
        throw err;
      }
      return this.createContact(customer, `${name} (${suffix})`);
    }
  }

  async findSalesDocument(externalRef: string): Promise<DocumentRef | null> {
    const data = await this.call(() =>
      this.ctx.http.get<{ Invoices?: XeroInvoice[] }>('/Invoices', {
        query: { where: `Type=="ACCREC" AND Reference==${quote(externalRef)}`, summaryOnly: true },
      }),
    );
    const invoice = (data.Invoices ?? []).find((i) => !DEAD_STATUSES.has(i.Status));
    return invoice ? invoiceRef(invoice) : null;
  }

  async createSalesDocument(input: SalesDocumentInput): Promise<DocumentRef> {
    const cur = input.currency;
    const salesAccount = this.setting('salesAccountCode') ?? '200';
    const lineItems: Array<Record<string, unknown>> = input.lines.map((line) => ({
      ItemCode: line.accountingProductId,
      Description: line.name,
      Quantity: line.quantity,
      UnitAmount: minorToNumber(line.unitPriceMinor, cur),
      DiscountRate: line.discountPercent || undefined,
      TaxType: line.taxCode ?? undefined,
      AccountCode: salesAccount,
    }));
    // a free delivery line would only clutter the invoice
    if (input.shipping && input.shipping.priceMinor > 0) {
      lineItems.push({
        Description: input.shipping.name,
        Quantity: 1,
        UnitAmount: minorToNumber(input.shipping.priceMinor, cur),
        TaxType: input.shipping.taxCode ?? undefined,
        AccountCode: this.setting('shippingAccountCode') ?? salesAccount,
      });
    }

    const dueDays = Number(this.ctx.settings.dueDays ?? 0) || 0;
    const data = await this.put<{ Invoices?: XeroInvoice[] }>('/Invoices', `invoice:${input.externalRef}`, {
      Invoices: [
        {
          Type: 'ACCREC',
          Contact: { ContactID: input.customerId },
          Date: isoDate(input.date),
          DueDate: isoDate(new Date(input.date.getTime() + dueDays * DAY_MS)),
          LineAmountTypes: input.pricesIncludeTax ? 'Inclusive' : 'Exclusive',
          Reference: input.externalRef,
          InvoiceNumber: `${this.setting('invoicePrefix') ?? 'WEB-'}${input.number}`,
          CurrencyCode: cur,
          Status: this.setting('invoiceStatus') ?? 'AUTHORISED',
          LineItems: lineItems,
        },
      ],
    });
    return invoiceRef(accepted(data.Invoices, 'invoice'));
  }

  async registerPayment(input: PaymentInput): Promise<DocumentRef> {
    const data = await this.put<{ Payments?: XeroPayment[] }>('/Payments', `payment:${input.reference}`, {
      Payments: [
        {
          Invoice: { InvoiceID: input.document.externalId },
          Account: { Code: this.setting('paymentAccountCode') ?? '090' },
          Date: isoDate(input.paidAt),
          Amount: minorToNumber(input.amountMinor, input.currency),
          Reference: input.reference,
        },
      ],
    });
    const payment = accepted(data.Payments, 'payment');
    // payments have no page of their own, they show up on the invoice
    return { externalId: payment.PaymentID, number: null, url: invoiceUrl(input.document.externalId) };
  }

  async listProducts(): Promise<CatalogProduct[]> {
    const cur = String(this.ctx.settings.currency ?? 'GBP');
    return (await this.items()).map((item) => ({
      externalId: item.Code,
      sku: item.Code,
      barcodes: [],
      name: item.Name ?? item.Code,
      priceMinor:
        item.SalesDetails?.UnitPrice === undefined ? null : toMinor(item.SalesDetails.UnitPrice, cur),
      vatRatePercent: null,
      archived: false,
    }));
  }

  // Xero has a single stock pool per item, so the warehouse is ignored
  async getStock(_warehouseId: string | null): Promise<StockLevel[]> {
    return (await this.items())
      .filter((item) => item.IsTrackedAsInventory)
      .map((item) => ({
        productExternalId: item.Code,
        available: Math.max(0, Math.floor(item.QuantityOnHand ?? 0)),
      }));
  }

  async listWarehouses(): Promise<NamedRef[]> {
    return [{ externalId: 'default', name: 'Xero tracked inventory' }];
  }

  async listOrderStatuses(): Promise<NamedRef[]> {
    return [
      { externalId: 'DRAFT', name: 'Draft' },
      { externalId: 'SUBMITTED', name: 'Awaiting approval' },
      { externalId: 'AUTHORISED', name: 'Awaiting payment' },
    ];
  }

  async listTaxRates(): Promise<TaxRate[]> {
    const data = await this.call(() => this.ctx.http.get<{ TaxRates?: XeroTaxRate[] }>('/TaxRates'));
    return (data.TaxRates ?? [])
      .filter((r) => r.Status === 'ACTIVE' && r.CanApplyToRevenue !== false)
      .map((r) => ({ code: r.TaxType, name: r.Name, ratePercent: r.EffectiveRate ?? 0 }));
  }

  private setting(key: string): string | null {
    const value = this.ctx.settings[key];
    return typeof value === 'string' && value ? value : null;
  }

  private async items(): Promise<XeroItem[]> {
    const data = await this.call(() => this.ctx.http.get<{ Items?: XeroItem[] }>('/Items'));
    return data.Items ?? [];
  }

  private async createContact(customer: Customer, name: string): Promise<string> {
    const address = customer.address;
    const data = await this.put<{ Contacts?: XeroContact[] }>('/Contacts', `contact:${customer.matchKey}`, {
      Contacts: [
        {
          Name: name,
          ContactNumber: customer.matchKey,
          FirstName: customer.firstName || undefined,
          LastName: customer.lastName || undefined,
          EmailAddress: customer.email ?? undefined,
          Phones: customer.phone ? [{ PhoneType: 'MOBILE', PhoneNumber: customer.phone }] : undefined,
          Addresses: address
            ? [
                {
                  AddressType: 'STREET',
                  AddressLine1: address.line1 ?? undefined,
                  AddressLine2: address.line2 ?? undefined,
                  City: address.city ?? undefined,
                  PostalCode: address.postcode ?? undefined,
                  Region: address.region ?? undefined,
                  Country: address.country ?? undefined,
                },
              ]
            : undefined,
        },
      ],
    });
    return accepted(data.Contacts, 'contact').ContactID;
  }

  // The body hash in the key lets a corrected retry through, in case Xero replays a stored rejection;
  // a plain resend after a lost response reuses the key and gets the original result back.
  private put<T>(path: string, ref: string, json: unknown): Promise<T> {
    const key = idempotencyKey(`${ref}:${digest(Buffer.from(JSON.stringify(json))).slice(0, 16)}`);
    return this.call(() => this.ctx.http.put<T>(path, { headers: { 'idempotency-key': key }, json }));
  }

  /** Runs a request with a fresh token; a 401 gets one refresh and one more try. */
  private async call<T>(send: () => Promise<HttpResponse<T>>): Promise<T> {
    const refreshedNow = await this.refreshIfExpiring();
    try {
      return (await send()).data;
    } catch (err) {
      if (!(err instanceof AuthError) || refreshedNow || !this.canRefresh) throw err;
      await this.refresh();
      return (await send()).data;
    }
  }

  private get canRefresh(): boolean {
    const { refreshToken, clientId, clientSecret } = this.credentials;
    return Boolean(refreshToken && clientId && clientSecret);
  }

  private async refreshIfExpiring(): Promise<boolean> {
    if (!this.expiresAt || this.expiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS) return false;
    await this.refresh();
    return true;
  }

  // parallel calls share one refresh: Xero rotates refresh tokens, a second use of the old one fails
  private refresh(): Promise<void> {
    this.refreshing ??= this.exchangeRefreshToken().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async exchangeRefreshToken(): Promise<void> {
    const { refreshToken, clientId, clientSecret } = this.credentials;
    if (!refreshToken || !clientId || !clientSecret) {
      throw new AuthError('xero', 'access token expired and there is no refresh token');
    }
    const identity = (this.setting('identityUrl') ?? 'https://identity.xero.com').replace(/\/+$/, '');
    let token: XeroTokenResponse;
    try {
      const { data } = await this.ctx.http.post<XeroTokenResponse>(`${identity}/connect/token`, {
        absolute: true,
        form: { grant_type: 'refresh_token', refresh_token: refreshToken },
        headers: { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` },
      });
      token = data;
    } catch (err) {
      // timeouts and 5xx are worth retrying later; anything else means the grant is gone
      if (err instanceof SyncError && err.retryable) throw err;
      const detail = err instanceof SyncError ? err.detail : String(err);
      throw new AuthError('xero', `token refresh failed: ${detail ?? 'unknown error'}`);
    }

    const expiresAt = new Date(Date.now() + token.expires_in * 1000);
    this.credentials = {
      ...this.credentials,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? refreshToken,
      expiresAt: expiresAt.toISOString(),
    };
    this.expiresAt = expiresAt;
    this.ctx.http.setHeader('authorization', `Bearer ${token.access_token}`);
    await this.ctx.onCredentialsRefreshed?.({ ...this.credentials }, expiresAt);
  }
}

/** First element of a Xero write response, or the validation errors Xero attached to it. */
function accepted<T extends XeroElement>(elements: T[] | undefined, what: string): T {
  const element = elements?.[0];
  if (!element) throw new ValidationRejectedError('xero', `empty ${what} response`);
  if (element.HasValidationErrors || element.ValidationErrors?.length) {
    const messages = (element.ValidationErrors ?? []).map((v) => v.Message).join('; ');
    throw new ValidationRejectedError('xero', messages || `${what} has validation errors`);
  }
  return element;
}

function invoiceRef(invoice: XeroInvoice): DocumentRef {
  return {
    externalId: invoice.InvoiceID,
    number: invoice.InvoiceNumber ?? null,
    url: invoiceUrl(invoice.InvoiceID),
  };
}

function invoiceUrl(invoiceId: string): string {
  return `https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${invoiceId}`;
}

// the where syntax has no documented escaping; emails and our refs never contain quotes anyway
function quote(value: string): string {
  return `"${value.replaceAll('"', '')}"`;
}

function idempotencyKey(key: string): string {
  return key.length <= IDEMPOTENCY_KEY_MAX ? key : digest(Buffer.from(key));
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function digest(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 32);
}

export const xeroFactory: AccountingConnectorFactory = {
  provider: 'xero',
  kind: 'accounting',
  create: (ctx) => new XeroConnector(ctx),
};
