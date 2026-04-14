// Subset of the Xero Accounting API 2.0 payloads we read and write.

export interface XeroValidationError {
  Message: string;
}

export interface XeroElement {
  HasValidationErrors?: boolean;
  ValidationErrors?: XeroValidationError[];
}

export interface XeroContact extends XeroElement {
  ContactID: string;
  ContactNumber?: string;
  Name: string;
  EmailAddress?: string;
  ContactStatus?: string;
}

export interface XeroInvoice extends XeroElement {
  InvoiceID: string;
  InvoiceNumber?: string;
  Reference?: string;
  Type: 'ACCREC' | 'ACCPAY';
  Status: 'DRAFT' | 'SUBMITTED' | 'AUTHORISED' | 'PAID' | 'VOIDED' | 'DELETED';
  AmountDue?: number;
  Payments?: Array<{ PaymentID: string }>;
}

export interface XeroPayment extends XeroElement {
  PaymentID: string;
  Reference?: string;
}

export interface XeroItem {
  ItemID: string;
  Code: string;
  Name?: string;
  IsTrackedAsInventory?: boolean;
  QuantityOnHand?: number;
  SalesDetails?: { UnitPrice?: number; AccountCode?: string; TaxType?: string };
}

export interface XeroTaxRate {
  Name: string;
  TaxType: string;
  Status: 'ACTIVE' | 'DELETED' | 'ARCHIVED' | 'PENDING';
  EffectiveRate?: number;
  CanApplyToRevenue?: boolean;
}

export interface XeroError {
  ErrorNumber?: number;
  Type?: string | null;
  Message?: string;
  Elements?: XeroElement[];
  // 401/403 come as RFC 7807 problem details
  Title?: string;
  Detail?: string;
  // the identity server answers in OAuth style
  error?: string;
  error_description?: string;
}

export interface XeroTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

export interface XeroWebhookBody {
  events: Array<{
    resourceId: string;
    resourceUrl: string;
    eventCategory: string;
    eventType: string;
    eventDateUtc: string;
    tenantId: string;
  }>;
  firstEventSequence: number;
  lastEventSequence: number;
  entropy?: string;
}
