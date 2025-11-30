// Provider-neutral shapes. Money is always integer minor units (cents, kopecks) to keep
// totals exact across APIs that use floats (Xero, MoySklad) and strings (WooCommerce).

export interface Address {
  line1: string | null;
  line2: string | null;
  city: string | null;
  postcode: string | null;
  region: string | null;
  country: string | null;
}

export interface Customer {
  /**
   * Our own key for this shopper, stored on the accounting contact (Xero ContactNumber,
   * MoySklad externalCode). Contacts are only reused when this key matches, never by email
   * alone: a guest checkout with someone else's address must not land on their account.
   */
  matchKey?: string;
  externalId: string | null;
  email: string | null;
  phone: string | null;
  firstName: string;
  lastName: string;
  company: string | null;
  address: Address | null;
}

export interface OrderLine {
  externalId: string;
  productExternalId: string;
  variantExternalId: string | null;
  sku: string | null;
  name: string;
  quantity: number;
  /** price of one unit before discounts, tax excluded */
  unitPriceMinor: number;
  /** discount for the whole line, tax excluded */
  discountMinor: number;
  taxRatePercent: number | null;
  taxMinor: number;
  /** line total after discount, tax excluded */
  totalMinor: number;
}

export interface Shipping {
  title: string;
  priceMinor: number;
  taxMinor: number;
  taxRatePercent: number | null;
}

export interface PaymentInfo {
  paid: boolean;
  paidAt: Date | null;
  method: string | null;
  transactionId: string | null;
}

export interface StoreOrder {
  externalId: string;
  number: string;
  status: string;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
  customer: Customer;
  lines: OrderLine[];
  shipping: Shipping | null;
  discountTotalMinor: number;
  taxTotalMinor: number;
  totalMinor: number;
  payment: PaymentInfo;
  note: string | null;
  adminUrl: string | null;
}

export interface StoreProductRef {
  productId: string;
  variantId: string | null;
  /** Shopify needs the inventory item id for stock updates */
  inventoryItemId?: string | null;
}

export interface StoreProduct extends StoreProductRef {
  sku: string;
  barcode: string | null;
  name: string;
  priceMinor: number;
  stock: number | null;
}

export interface NewStoreProduct {
  sku: string;
  barcode: string | null;
  name: string;
  description: string | null;
  priceMinor: number;
  stock: number;
}

export interface CatalogProduct {
  externalId: string;
  sku: string | null;
  barcodes: string[];
  name: string;
  priceMinor: number | null;
  vatRatePercent: number | null;
  archived: boolean;
}

export interface StockLevel {
  productExternalId: string;
  available: number;
}

export interface NamedRef {
  externalId: string;
  name: string;
}

export interface TaxRate {
  code: string;
  name: string;
  ratePercent: number;
}

export interface DocumentRef {
  externalId: string;
  number: string | null;
  url: string | null;
}

export interface SalesDocumentLine {
  accountingProductId: string;
  name: string;
  quantity: number;
  unitPriceMinor: number;
  discountPercent: number;
  taxCode: string | null;
  taxRatePercent: number | null;
}

export interface SalesDocumentInput {
  /** our reference, stored on the document so a lost response can be detected later */
  externalRef: string;
  number: string;
  date: Date;
  currency: string;
  customerId: string;
  lines: SalesDocumentLine[];
  shipping: {
    name: string;
    priceMinor: number;
    taxCode: string | null;
    taxRatePercent: number | null;
  } | null;
  pricesIncludeTax: boolean;
  warehouseId: string | null;
  statusId: string | null;
  comment: string | null;
}

export interface PaymentInput {
  document: DocumentRef;
  customerId: string;
  amountMinor: number;
  currency: string;
  paidAt: Date;
  reference: string;
}

export interface BatchResult {
  updated: number;
  failed: Array<{ ref: StoreProductRef; reason: string }>;
}

export type WebhookTopic =
  | 'order.created'
  | 'order.updated'
  | 'order.paid'
  | 'product.created'
  | 'product.updated'
  | 'stock.changed'
  | 'ping';

export interface WebhookEvent {
  topic: WebhookTopic;
  /** provider delivery id, used to drop duplicates */
  deliveryId: string;
  /** id of the changed entity on the provider side */
  entityId: string | null;
}

export interface IncomingWebhook {
  headers: Record<string, string | undefined>;
  /** query string of the delivery URL; MoySklad does not sign webhooks, so we put a secret there */
  query?: Record<string, string | undefined>;
  rawBody: Buffer;
}
