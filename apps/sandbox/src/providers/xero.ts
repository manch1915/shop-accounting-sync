import { createHash } from 'node:crypto';
import { type Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { type FaultSettings, faultInjection, RequestWindow } from '../faults.js';
import { newUuid, newXeroId, XERO } from '../ids.js';
import { addedVat, includedVat, toNumber } from '../money.js';
import type { Random } from '../random.js';
import { xeroDate } from '../state/clock.js';
import type { SandboxState } from '../state/sandbox.js';
import type {
  XeroContactRec,
  XeroInvoiceRec,
  XeroItemRec,
  XeroLineRec,
  XeroOrg,
  XeroPaymentRec,
} from '../state/xero.js';

type Json = Record<string, unknown>;
interface Reply {
  status: ContentfulStatusCode;
  body: unknown;
}

/**
 * Demo rule, not a Xero one: invoices above £400 are refused with a validation error, so a few
 * wholesale orders end up in the dead-letter queue every hour and the retry screen has something
 * to show. Raise or remove it here.
 */
export const DEMO_INVOICE_LIMIT_MINOR = 40_000;

// Xero allows 60 calls per minute and 5000 per day for each tenant
const MINUTE_LIMIT = 60;
const DAY_LIMIT = 5_000;
const IDEMPOTENCY_KEY_MAX = 128;
const PROVIDER_NAME = 'Shop Accounting Sync';

export function xeroApp(state: SandboxState, faults: FaultSettings, random: Random): Hono {
  const app = new Hono();
  const org = state.xero;
  const minute = new RequestWindow(MINUTE_LIMIT, 60_000);
  const day = new RequestWindow(DAY_LIMIT, 86_400_000);

  app.use('*', async (c, next) => {
    const token = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '')?.[1] ?? '';
    if (!org.isValidAccessToken(token)) {
      const detail = org.isExpiredAccessToken(token)
        ? `TokenExpired: token expired at ${new Date().toLocaleString('en-US', { timeZone: 'UTC', hour12: false })}`
        : 'AuthenticationUnsuccessful';
      return problem(c, 401, 'Unauthorized', detail);
    }
    if (c.req.header('xero-tenant-id') !== XERO.tenantId) {
      return problem(c, 403, 'Forbidden', 'AuthorizationUnsuccessful');
    }
    const perMinute = minute.hit();
    const perDay = day.hit();
    c.header('X-MinLimit-Remaining', String(perMinute.remaining));
    c.header('X-DayLimit-Remaining', String(perDay.remaining));
    c.header('X-AppMinLimit-Remaining', '9999');
    if (!perMinute.allowed) return rateLimited(c, Math.ceil(perMinute.retryAfterMs / 1000));
    await next();
  });

  app.use(
    '*',
    faultInjection(
      faults,
      {
        rateLimited: (c) => rateLimited(c, random.int(2, 5)),
        unavailable: (c) =>
          problem(
            c,
            503,
            'Service Unavailable',
            'The Xero API is temporarily unavailable. Please try again later.',
          ),
      },
      random,
    ),
  );

  app.get('/Organisation', (c) =>
    c.json(
      envelope('Organisations', [
        {
          OrganisationID: XERO.tenantId,
          Name: org.name,
          LegalName: 'Hillside Tea Company Ltd',
          BaseCurrency: 'GBP',
          CountryCode: 'GB',
          OrganisationType: 'COMPANY',
          IsDemoCompany: true,
          OrganisationStatus: 'ACTIVE',
          Timezone: 'GMTSTANDARDTIME',
        },
      ]),
    ),
  );
  app.get('/Accounts', (c) =>
    c.json(
      envelope(
        'Accounts',
        org.accounts.map((a) => ({ ...a, Status: 'ACTIVE' })),
      ),
    ),
  );
  app.get('/TaxRates', (c) =>
    c.json(
      envelope(
        'TaxRates',
        org.taxRates.map((r) => ({
          Name: r.Name,
          TaxType: r.TaxType,
          ReportTaxType: r.ReportTaxType,
          CanApplyToAssets: true,
          CanApplyToEquity: true,
          CanApplyToExpenses: !r.CanApplyToRevenue,
          CanApplyToLiabilities: true,
          CanApplyToRevenue: r.CanApplyToRevenue,
          DisplayTaxRate: r.EffectiveRate,
          EffectiveRate: r.EffectiveRate,
          Status: r.Status,
          TaxComponents: [{ Name: 'VAT', Rate: r.EffectiveRate, IsCompound: false, IsNonRecoverable: false }],
        })),
      ),
    ),
  );

  app.get('/Items', (c) => c.json(envelope('Items', [...org.items.values()].map(itemJson))));
  app.get('/Items/:id', (c) => {
    const key = c.req.param('id');
    const item = org.items.get(key) ?? [...org.items.values()].find((i) => i.ItemID === key);
    return item ? c.json(envelope('Items', [itemJson(item)])) : notFound(c);
  });

  app.get('/Contacts', (c) => {
    const filter = parseWhere(c.req.query('where'), contactField);
    if ('error' in filter) return c.json(filter.error, 400);
    const rows = [...org.contacts.values()].filter((contact) => filter.test(contact));
    return c.json(envelope('Contacts', rows.map(contactJson)));
  });
  app.get('/Contacts/:id', (c) => {
    const contact = org.contacts.get(c.req.param('id'));
    return contact ? c.json(envelope('Contacts', [contactJson(contact)])) : notFound(c);
  });
  app.on(['PUT', 'POST'], '/Contacts', (c) => idempotent(c, org, (body) => createContacts(org, body)));

  app.get('/Invoices', (c) => {
    const filter = parseWhere(c.req.query('where'), invoiceField);
    if ('error' in filter) return c.json(filter.error, 400);
    const summary = c.req.query('summaryOnly') === 'true';
    const rows = [...org.invoices.values()].filter((invoice) => filter.test(invoice));
    return c.json(
      envelope(
        'Invoices',
        rows.map((i) => invoiceJson(org, i, summary)),
      ),
    );
  });
  app.get('/Invoices/:id', (c) => {
    const invoice = org.invoices.get(c.req.param('id'));
    return invoice ? c.json(envelope('Invoices', [invoiceJson(org, invoice, false)])) : notFound(c);
  });
  app.on(['PUT', 'POST'], '/Invoices', (c) => idempotent(c, org, (body) => createInvoices(org, body)));

  app.get('/Payments', (c) =>
    c.json(
      envelope(
        'Payments',
        [...org.payments.values()].map((p) => paymentJson(org, p)),
      ),
    ),
  );
  app.on(['PUT', 'POST'], '/Payments', (c) => idempotent(c, org, (body) => createPayments(org, body)));

  app.all('*', (c) => notFound(c));
  return app;
}

export function xeroIdentityApp(state: SandboxState, token: string): Hono {
  const app = new Hono();
  app.post('/connect/token', async (c) => {
    const basic = /^Basic (.+)$/.exec(c.req.header('authorization') ?? '')?.[1];
    const [clientId, clientSecret] = basic ? Buffer.from(basic, 'base64').toString('utf8').split(':') : [];
    if (clientId !== XERO.clientId || clientSecret !== token) return c.json({ error: 'invalid_client' }, 400);
    const form = new URLSearchParams(await c.req.text());
    if (form.get('grant_type') !== 'refresh_token') return c.json({ error: 'unsupported_grant_type' }, 400);
    const issued = state.xero.refresh(form.get('refresh_token') ?? '');
    if (!issued) return c.json({ error: 'invalid_grant' }, 400);
    return c.json({
      ...issued,
      token_type: 'Bearer',
      scope:
        'openid profile email accounting.transactions accounting.settings accounting.contacts offline_access',
    });
  });
  app.all('*', (c) => c.json({ error: 'not_found' }, 404));
  return app;
}

function problem(c: Context, status: 401 | 403 | 404 | 503, title: string, detail: string) {
  return c.json(
    { Type: null, Title: title, Status: status, Detail: detail, Instance: newUuid(), Extensions: {} },
    status,
  );
}

function notFound(c: Context) {
  return problem(c, 404, 'Not Found', 'The resource you are looking for cannot be found');
}

function rateLimited(c: Context, seconds: number) {
  c.header('Retry-After', String(seconds));
  c.header('X-Rate-Limit-Problem', 'minute');
  return c.json(
    { Type: null, Title: 'Too Many Requests', Status: 429, Detail: 'Rate limit exceeded', Extensions: {} },
    429,
  );
}

function envelope(key: string, rows: unknown[]) {
  return {
    Id: newUuid(),
    Status: 'OK',
    ProviderName: PROVIDER_NAME,
    DateTimeUTC: xeroDate(new Date()).replace('+0000', ''),
    [key]: rows,
  };
}

function validationError(elements: Json[]): Reply {
  return {
    status: 400,
    body: {
      ErrorNumber: 10,
      Type: 'ValidationException',
      Message: 'A validation exception occurred',
      Elements: elements,
    },
  };
}

/**
 * Same Idempotency-Key and same body: the stored answer comes back, rejections included.
 * Same key with another body is refused.
 */
async function idempotent(c: Context, org: XeroOrg, handle: (body: Json) => Reply) {
  const raw = await c.req.text();
  const key = c.req.header('idempotency-key');
  if (key && key.length > IDEMPOTENCY_KEY_MAX) {
    return c.json(
      {
        Type: null,
        Title: 'Bad Request',
        Status: 400,
        Detail: `Idempotency-Key must be ${IDEMPOTENCY_KEY_MAX} characters or less`,
      },
      400,
    );
  }
  const scope = key ? `${c.req.method} ${c.req.path} ${key}` : null;
  const fingerprint = createHash('sha256').update(raw).digest('hex');
  const stored = scope ? org.idempotency.get(scope) : undefined;
  if (stored) {
    if (stored.fingerprint !== fingerprint) {
      return c.json(
        {
          Type: null,
          Title: 'Bad Request',
          Status: 400,
          Detail: 'The Idempotency-Key has already been used with a different request body',
        },
        400,
      );
    }
    return c.json(stored.body, stored.status as ContentfulStatusCode);
  }
  let body: Json;
  try {
    body = JSON.parse(raw) as Json;
  } catch {
    return c.json({ ErrorNumber: 14, Type: 'PostDataInvalidException', Message: 'Invalid Json data' }, 400);
  }
  const reply = handle(body);
  if (scope) org.idempotency.set(scope, { fingerprint, status: reply.status, body: reply.body });
  return c.json(reply.body, reply.status);
}

function createContacts(org: XeroOrg, body: Json): Reply {
  const inputs = Array.isArray(body.Contacts) ? (body.Contacts as Json[]) : [body];
  const created: XeroContactRec[] = [];
  for (const input of inputs) {
    const name = typeof input.Name === 'string' ? input.Name.trim() : '';
    const errors: string[] = [];
    if (!name) errors.push('A Contact Name must be specified.');
    const taken = [...org.contacts.values(), ...created].some(
      (c) => c.Name.toLowerCase() === name.toLowerCase(),
    );
    if (name && taken) {
      errors.push(
        `The contact name ${name} is already assigned to another contact. The contact name must be unique across all active contacts.`,
      );
    }
    if (errors.length) {
      return validationError([
        {
          ContactID: '00000000-0000-0000-0000-000000000000',
          Name: name,
          EmailAddress: input.EmailAddress,
          HasValidationErrors: true,
          ValidationErrors: errors.map((Message) => ({ Message })),
        },
      ]);
    }
    created.push({
      ContactID: newXeroId(),
      ContactNumber: typeof input.ContactNumber === 'string' ? input.ContactNumber.slice(0, 50) : null,
      Name: name,
      FirstName: str(input.FirstName),
      LastName: str(input.LastName),
      EmailAddress: str(input.EmailAddress),
      Phones: Array.isArray(input.Phones) ? input.Phones : [],
      Addresses: Array.isArray(input.Addresses) ? input.Addresses : [],
      updated: new Date(),
    });
  }
  for (const contact of created) org.contacts.set(contact.ContactID, contact);
  return {
    status: 200,
    body: envelope(
      'Contacts',
      created.map((c) => ({ ...contactJson(c), HasValidationErrors: false })),
    ),
  };
}

function createInvoices(org: XeroOrg, body: Json): Reply {
  const inputs = Array.isArray(body.Invoices) ? (body.Invoices as Json[]) : [body];
  const created: XeroInvoiceRec[] = [];
  for (const input of inputs) {
    const result = buildInvoice(org, input, created);
    if ('errors' in result) {
      return validationError([
        {
          Type: input.Type,
          InvoiceNumber: input.InvoiceNumber,
          Reference: input.Reference,
          Status: input.Status,
          HasValidationErrors: true,
          ValidationErrors: result.errors.map((Message) => ({ Message })),
        },
      ]);
    }
    created.push(result);
  }
  for (const invoice of created) {
    org.invoices.set(invoice.InvoiceID, invoice);
    // approved sales invoices take tracked items out of stock, as in a real Xero organisation
    if (invoice.Type !== 'ACCREC' || invoice.Status !== 'AUTHORISED') continue;
    for (const line of invoice.lines) {
      const item = line.ItemCode ? org.items.get(line.ItemCode) : undefined;
      if (item?.tracked) {
        item.quantity = Math.max(0, item.quantity - line.Quantity);
        item.updated = new Date();
      }
    }
  }
  return {
    status: 200,
    body: envelope(
      'Invoices',
      created.map((i) => ({ ...invoiceJson(org, i, false), HasValidationErrors: false })),
    ),
  };
}

function buildInvoice(
  org: XeroOrg,
  input: Json,
  pending: XeroInvoiceRec[],
): XeroInvoiceRec | { errors: string[] } {
  const errors: string[] = [];
  const type = input.Type === 'ACCPAY' ? 'ACCPAY' : input.Type === 'ACCREC' ? 'ACCREC' : null;
  if (!type) errors.push('Invoice Type must be specified.');
  const contactId = str((input.Contact as Json | undefined)?.ContactID);
  if (!contactId || !org.contacts.has(contactId)) errors.push('The Contact could not be found.');
  const lineAmountTypes =
    input.LineAmountTypes === 'Inclusive' || input.LineAmountTypes === 'NoTax'
      ? input.LineAmountTypes
      : 'Exclusive';
  const status = input.Status === 'AUTHORISED' || input.Status === 'SUBMITTED' ? input.Status : 'DRAFT';
  const number =
    str(input.InvoiceNumber) ?? `INV-${String(org.invoices.size + pending.length + 1).padStart(4, '0')}`;
  const allInvoices = [...org.invoices.values(), ...pending];
  if (
    type === 'ACCREC' &&
    allInvoices.some(
      (i) =>
        i.Type === 'ACCREC' && i.InvoiceNumber === number && i.Status !== 'DELETED' && i.Status !== 'VOIDED',
    )
  ) {
    errors.push('Invoice # must be unique.');
  }
  const date = parseDate(input.Date) ?? new Date();
  const dueDate = parseDate(input.DueDate) ?? date;

  const rawLines = Array.isArray(input.LineItems) ? (input.LineItems as Json[]) : [];
  if (!rawLines.length) errors.push('Invoices must have at least one line item.');
  const lines: XeroLineRec[] = [];
  for (const raw of rawLines) {
    const code = str(raw.ItemCode);
    const item = code ? org.items.get(code) : undefined;
    if (code && !item) errors.push(`Item code '${code}' is not valid`);
    const taxType = str(raw.TaxType) ?? item?.taxType ?? 'OUTPUT2';
    const rate = org.taxRate(taxType);
    if (rate?.Status !== 'ACTIVE' || (type === 'ACCREC' && !rate.CanApplyToRevenue)) {
      errors.push(
        `The TaxType code '${taxType}' does not exist or cannot be used for this type of transaction.`,
      );
    }
    const accountCode = str(raw.AccountCode) ?? '200';
    if (!org.accounts.some((a) => a.Code === accountCode && a.Type === 'REVENUE')) {
      errors.push(`Account code '${accountCode}' is not a valid code for this document.`);
    }
    const quantity = Number(raw.Quantity ?? 1);
    const unit = Number(raw.UnitAmount ?? (item ? item.priceMinor / 100 : 0));
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unit)) {
      errors.push('The Quantity and UnitAmount of a line item must be numbers.');
      continue;
    }
    const discountRate = raw.DiscountRate === undefined ? null : Number(raw.DiscountRate);
    const unitMinor = Math.round(unit * 100);
    const gross = Math.round(unitMinor * quantity);
    const lineMinor = gross - (discountRate ? Math.round((gross * discountRate) / 100) : 0);
    const percent = rate?.EffectiveRate ?? 0;
    const taxMinor =
      lineAmountTypes === 'Exclusive'
        ? addedVat(lineMinor, percent)
        : lineAmountTypes === 'Inclusive'
          ? includedVat(lineMinor, percent)
          : 0;
    lines.push({
      LineItemID: newXeroId(),
      ItemCode: code,
      Description: str(raw.Description) ?? item?.Name ?? '',
      Quantity: quantity,
      unitMinor,
      DiscountRate: discountRate,
      TaxType: taxType,
      taxMinor,
      lineMinor,
      AccountCode: accountCode,
    });
  }
  const totalTax = lines.reduce((s, l) => s + l.taxMinor, 0);
  const lineTotal = lines.reduce((s, l) => s + l.lineMinor, 0);
  const subTotal = lineAmountTypes === 'Inclusive' ? lineTotal - totalTax : lineTotal;
  const total = subTotal + totalTax;
  if (type === 'ACCREC' && total > DEMO_INVOICE_LIMIT_MINOR) {
    errors.push('The document total exceeds the limit allowed for this demo organisation');
  }
  if (errors.length || !type || !contactId) return { errors };
  return {
    InvoiceID: newXeroId(),
    InvoiceNumber: number,
    Reference: str(input.Reference) ?? '',
    Type: type,
    ContactID: contactId,
    Date: date,
    DueDate: dueDate,
    Status: status,
    LineAmountTypes: lineAmountTypes,
    lines,
    subTotal,
    totalTax,
    total,
    amountPaid: 0,
    CurrencyCode: str(input.CurrencyCode) ?? 'GBP',
    updated: new Date(),
  };
}

function createPayments(org: XeroOrg, body: Json): Reply {
  const inputs = Array.isArray(body.Payments) ? (body.Payments as Json[]) : [body];
  const created: XeroPaymentRec[] = [];
  for (const input of inputs) {
    const errors: string[] = [];
    const ref = (input.Invoice ?? {}) as Json;
    const invoice =
      org.invoices.get(str(ref.InvoiceID) ?? '') ??
      [...org.invoices.values()].find((i) => ref.InvoiceNumber && i.InvoiceNumber === ref.InvoiceNumber);
    if (!invoice) errors.push('Invoice could not be found');
    else if (invoice.Status !== 'AUTHORISED')
      errors.push('Payments can only be made against Authorised documents');
    const accountRef = (input.Account ?? {}) as Json;
    const account = org.accounts.find(
      (a) => a.Code === accountRef.Code || a.AccountID === accountRef.AccountID,
    );
    if (account?.Type !== 'BANK') errors.push('Account code must be a bank account or have payments enabled');
    const amountMinor = Math.round(Number(input.Amount ?? 0) * 100);
    if (!(amountMinor > 0)) errors.push('Payment amount must be greater than zero');
    if (invoice && amountMinor > invoice.total - invoice.amountPaid) {
      errors.push('Payment amount exceeds the amount outstanding on this document');
    }
    if (errors.length || !invoice || !account) {
      return validationError([
        {
          PaymentID: '00000000-0000-0000-0000-000000000000',
          Amount: input.Amount,
          Reference: input.Reference,
          HasValidationErrors: true,
          ValidationErrors: errors.map((Message) => ({ Message })),
        },
      ]);
    }
    const now = new Date();
    invoice.amountPaid += amountMinor;
    if (invoice.amountPaid >= invoice.total) invoice.Status = 'PAID';
    invoice.updated = now;
    created.push({
      PaymentID: newXeroId(),
      InvoiceID: invoice.InvoiceID,
      Date: parseDate(input.Date) ?? now,
      amountMinor,
      Reference: str(input.Reference) ?? '',
      AccountCode: account.Code,
      updated: now,
    });
  }
  for (const payment of created) org.payments.set(payment.PaymentID, payment);
  return {
    status: 200,
    body: envelope(
      'Payments',
      created.map((p) => ({ ...paymentJson(org, p), HasValidationErrors: false })),
    ),
  };
}

function itemJson(item: XeroItemRec) {
  return {
    ItemID: item.ItemID,
    Code: item.Code,
    Name: item.Name,
    Description: item.Name,
    IsSold: true,
    IsPurchased: item.tracked,
    IsTrackedAsInventory: item.tracked,
    ...(item.tracked
      ? { InventoryAssetAccountCode: '630', QuantityOnHand: item.quantity, TotalCostPool: 0 }
      : {}),
    SalesDetails: { UnitPrice: toNumber(item.priceMinor), AccountCode: '200', TaxType: item.taxType },
    UpdatedDateUTC: xeroDate(item.updated),
  };
}

function contactJson(c: XeroContactRec) {
  return {
    ContactID: c.ContactID,
    ...(c.ContactNumber ? { ContactNumber: c.ContactNumber } : {}),
    ContactStatus: 'ACTIVE',
    Name: c.Name,
    ...(c.FirstName ? { FirstName: c.FirstName } : {}),
    ...(c.LastName ? { LastName: c.LastName } : {}),
    ...(c.EmailAddress ? { EmailAddress: c.EmailAddress } : {}),
    Addresses: c.Addresses,
    Phones: c.Phones,
    UpdatedDateUTC: xeroDate(c.updated),
    IsSupplier: false,
    IsCustomer: true,
  };
}

function invoiceJson(org: XeroOrg, i: XeroInvoiceRec, summaryOnly: boolean) {
  const contact = org.contacts.get(i.ContactID);
  const payments = [...org.payments.values()].filter((p) => p.InvoiceID === i.InvoiceID);
  return {
    Type: i.Type,
    InvoiceID: i.InvoiceID,
    InvoiceNumber: i.InvoiceNumber,
    Reference: i.Reference,
    Contact: { ContactID: i.ContactID, Name: contact?.Name ?? '' },
    Date: xeroDate(i.Date),
    DateString: `${i.Date.toISOString().slice(0, 10)}T00:00:00`,
    DueDate: xeroDate(i.DueDate),
    DueDateString: `${i.DueDate.toISOString().slice(0, 10)}T00:00:00`,
    Status: i.Status,
    LineAmountTypes: i.LineAmountTypes,
    ...(summaryOnly
      ? {}
      : {
          LineItems: i.lines.map((l) => ({
            LineItemID: l.LineItemID,
            ...(l.ItemCode ? { ItemCode: l.ItemCode } : {}),
            Description: l.Description,
            Quantity: l.Quantity,
            UnitAmount: toNumber(l.unitMinor),
            ...(l.DiscountRate ? { DiscountRate: l.DiscountRate } : {}),
            TaxType: l.TaxType,
            TaxAmount: toNumber(l.taxMinor),
            LineAmount: toNumber(l.lineMinor),
            AccountCode: l.AccountCode,
          })),
          Payments: payments.map((p) => ({
            PaymentID: p.PaymentID,
            Date: xeroDate(p.Date),
            Amount: toNumber(p.amountMinor),
            Reference: p.Reference,
          })),
        }),
    SubTotal: toNumber(i.subTotal),
    TotalTax: toNumber(i.totalTax),
    Total: toNumber(i.total),
    AmountDue: toNumber(i.total - i.amountPaid),
    AmountPaid: toNumber(i.amountPaid),
    AmountCredited: 0,
    CurrencyCode: i.CurrencyCode,
    CurrencyRate: 1,
    UpdatedDateUTC: xeroDate(i.updated),
    HasAttachments: false,
  };
}

function paymentJson(org: XeroOrg, p: XeroPaymentRec) {
  const invoice = org.invoices.get(p.InvoiceID);
  const account = org.accounts.find((a) => a.Code === p.AccountCode);
  return {
    PaymentID: p.PaymentID,
    Date: xeroDate(p.Date),
    Amount: toNumber(p.amountMinor),
    Reference: p.Reference,
    CurrencyRate: 1,
    PaymentType: 'ACCRECPAYMENT',
    Status: 'AUTHORISED',
    IsReconciled: false,
    Account: { AccountID: account?.AccountID, Code: p.AccountCode },
    Invoice: { InvoiceID: p.InvoiceID, InvoiceNumber: invoice?.InvoiceNumber, Type: invoice?.Type },
    UpdatedDateUTC: xeroDate(p.updated),
  };
}

type FieldReader<T> = (record: T, field: string) => string | undefined;

const contactField: FieldReader<XeroContactRec> = (c, field) =>
  ({
    ContactID: c.ContactID,
    ContactNumber: c.ContactNumber ?? '',
    Name: c.Name,
    FirstName: c.FirstName ?? '',
    LastName: c.LastName ?? '',
    EmailAddress: c.EmailAddress ?? '',
    ContactStatus: 'ACTIVE',
  })[field];

const invoiceField: FieldReader<XeroInvoiceRec> = (i, field) =>
  ({
    InvoiceID: i.InvoiceID,
    InvoiceNumber: i.InvoiceNumber,
    Reference: i.Reference,
    Type: i.Type,
    Status: i.Status,
    'Contact.ContactID': i.ContactID,
  })[field];

/** the part of Xero's where syntax the connectors use: Field=="value" joined with AND */
function parseWhere<T>(
  where: string | undefined,
  read: FieldReader<T>,
): { test: (r: T) => boolean } | { error: Json } {
  if (!where?.trim()) return { test: () => true };
  const clauses: Array<{ field: string; negate: boolean; value: string }> = [];
  for (const part of where.split(/\s+AND\s+/i)) {
    const match = /^\s*\(?\s*([\w.]+)\s*(==|!=)\s*"([^"]*)"\s*\)?\s*$/.exec(part);
    if (!match)
      return {
        error: {
          ErrorNumber: 16,
          Type: 'QueryParseException',
          Message: `Unable to parse where clause: ${part.trim()}`,
        },
      };
    clauses.push({ field: match[1] ?? '', negate: match[2] === '!=', value: match[3] ?? '' });
  }
  return {
    test: (record) =>
      clauses.every(({ field, negate, value }) => {
        const actual = read(record, field);
        return actual === undefined ? false : (actual === value) !== negate;
      }),
  };
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}
