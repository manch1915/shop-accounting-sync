import { randomBytes } from 'node:crypto';
import type { DemoProduct } from '@sas/demo-data';
import { xeroId } from '../ids.js';

export interface XeroItemRec {
  ItemID: string;
  Code: string;
  Name: string;
  tracked: boolean;
  quantity: number;
  priceMinor: number;
  taxType: string;
  updated: Date;
}

export interface XeroContactRec {
  ContactID: string;
  ContactNumber: string | null;
  Name: string;
  FirstName: string | null;
  LastName: string | null;
  EmailAddress: string | null;
  Phones: unknown[];
  Addresses: unknown[];
  updated: Date;
}

export interface XeroLineRec {
  LineItemID: string;
  ItemCode: string | null;
  Description: string;
  Quantity: number;
  unitMinor: number;
  DiscountRate: number | null;
  TaxType: string;
  taxMinor: number;
  lineMinor: number;
  AccountCode: string;
}

export interface XeroInvoiceRec {
  InvoiceID: string;
  InvoiceNumber: string;
  Reference: string;
  Type: 'ACCREC' | 'ACCPAY';
  ContactID: string;
  Date: Date;
  DueDate: Date;
  Status: 'DRAFT' | 'SUBMITTED' | 'AUTHORISED' | 'PAID' | 'VOIDED' | 'DELETED';
  LineAmountTypes: 'Exclusive' | 'Inclusive' | 'NoTax';
  lines: XeroLineRec[];
  subTotal: number;
  totalTax: number;
  total: number;
  amountPaid: number;
  CurrencyCode: string;
  updated: Date;
}

export interface XeroPaymentRec {
  PaymentID: string;
  InvoiceID: string;
  Date: Date;
  amountMinor: number;
  Reference: string;
  AccountCode: string;
  updated: Date;
}

export interface XeroTaxRateRec {
  Name: string;
  TaxType: string;
  ReportTaxType: string;
  EffectiveRate: number;
  CanApplyToRevenue: boolean;
  Status: 'ACTIVE' | 'ARCHIVED';
}

export interface StoredResponse {
  fingerprint: string;
  status: number;
  body: unknown;
}

const ACCESS_TOKEN_TTL_SEC = 30 * 60;

export class XeroOrg {
  readonly name = 'Hillside Tea Co.';
  readonly items = new Map<string, XeroItemRec>();
  readonly contacts = new Map<string, XeroContactRec>();
  readonly invoices = new Map<string, XeroInvoiceRec>();
  readonly payments = new Map<string, XeroPaymentRec>();
  readonly idempotency = new Map<string, StoredResponse>();
  readonly taxRates: XeroTaxRateRec[] = [
    rate('20% (VAT on Income)', 'OUTPUT2', 'OUTPUT', 20),
    rate('5% (VAT on Income)', 'RROUTPUT', 'OUTPUT', 5),
    rate('Zero Rated Income', 'ZERORATEDOUTPUT', 'OUTPUT', 0),
    rate('Exempt Income', 'EXEMPTOUTPUT', 'EXEMPTOUTPUT', 0),
    rate('No VAT', 'NONE', 'NONE', 0),
    { ...rate('20% (VAT on Expenses)', 'INPUT2', 'INPUT', 20), CanApplyToRevenue: false },
  ];
  readonly accounts = [
    { Code: '200', Name: 'Sales', Type: 'REVENUE', AccountID: xeroId('account:200') },
    { Code: '260', Name: 'Other Revenue', Type: 'REVENUE', AccountID: xeroId('account:260') },
    { Code: '090', Name: 'Business Bank Account', Type: 'BANK', AccountID: xeroId('account:090') },
    { Code: '091', Name: 'Business Savings Account', Type: 'BANK', AccountID: xeroId('account:091') },
  ];
  /** access token -> expiry */
  private readonly accessTokens = new Map<string, number>();
  private refreshTokens: { current: string; previous: string | null };

  constructor(
    catalog: DemoProduct[],
    private readonly masterToken: string,
    now = new Date(),
  ) {
    this.refreshTokens = { current: masterToken, previous: null };
    for (const item of catalog) {
      if (item.storeOnly) continue;
      const code = item.accountingSku ?? item.sku;
      this.items.set(code, {
        ItemID: xeroId(`item:${code}`),
        Code: code,
        Name: item.option ? `${item.name}, ${item.option}` : item.name,
        tracked: !item.untracked,
        quantity: item.untracked ? 0 : item.stock,
        priceMinor: item.priceMinor,
        taxType: item.vat === null ? 'NONE' : item.vat === 0 ? 'ZERORATEDOUTPUT' : 'OUTPUT2',
        updated: now,
      });
    }
  }

  taxRate(type: string): XeroTaxRateRec | undefined {
    return this.taxRates.find((r) => r.TaxType === type);
  }

  isValidAccessToken(token: string, now = Date.now()): boolean {
    if (token === this.masterToken) return true;
    const expires = this.accessTokens.get(token);
    return expires !== undefined && expires > now;
  }

  isExpiredAccessToken(token: string, now = Date.now()): boolean {
    const expires = this.accessTokens.get(token);
    return expires !== undefined && expires <= now;
  }

  // refresh tokens rotate on every use; the previous one still works once more, which covers
  // a client that lost the response of its last refresh
  refresh(refreshToken: string, now = Date.now()) {
    const known =
      refreshToken === this.masterToken ||
      refreshToken === this.refreshTokens.current ||
      refreshToken === this.refreshTokens.previous;
    if (!known) return null;
    const access = randomBytes(24).toString('base64url');
    const next = randomBytes(24).toString('hex');
    this.accessTokens.set(access, now + ACCESS_TOKEN_TTL_SEC * 1000);
    this.refreshTokens = { current: next, previous: refreshToken === this.masterToken ? null : refreshToken };
    return { access_token: access, refresh_token: next, expires_in: ACCESS_TOKEN_TTL_SEC };
  }
}

function rate(Name: string, TaxType: string, ReportTaxType: string, EffectiveRate: number): XeroTaxRateRec {
  return { Name, TaxType, ReportTaxType, EffectiveRate, CanApplyToRevenue: true, Status: 'ACTIVE' };
}
