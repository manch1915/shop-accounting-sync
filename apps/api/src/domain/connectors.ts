import type { AccountingProvider, StoreProvider } from '@sas/shared';
import type { HttpClient } from '../connectors/http/http-client.js';
import type {
  BatchResult,
  CatalogProduct,
  Customer,
  DocumentRef,
  IncomingWebhook,
  NamedRef,
  NewStoreProduct,
  PaymentInput,
  SalesDocumentInput,
  StockLevel,
  StoreOrder,
  StoreProduct,
  StoreProductRef,
  TaxRate,
  WebhookEvent,
} from './models.js';

export type Credentials = Record<string, string>;

export interface ConnectorContext {
  connectionId: string;
  baseUrl: string;
  credentials: Credentials;
  settings: Record<string, unknown>;
  http: HttpClient;
  /** called when an OAuth connector refreshes its tokens, so they can be stored */
  onCredentialsRefreshed?: (credentials: Credentials, expiresAt: Date | null) => Promise<void>;
}

export interface WebhookAware {
  /** constant-time HMAC check against the secret configured for the connection */
  verifyWebhook(webhook: IncomingWebhook, secret: string): boolean;
  parseWebhook(webhook: IncomingWebhook): WebhookEvent[];
}

export interface StoreConnector extends WebhookAware {
  readonly provider: StoreProvider;
  getOrder(externalId: string): Promise<StoreOrder>;
  /** orders changed after `since`, oldest first; used by reconciliation to catch lost webhooks */
  listOrdersUpdatedSince(since: Date, limit: number): Promise<StoreOrder[]>;
  listProducts(): Promise<StoreProduct[]>;
  updateStock(updates: Array<{ ref: StoreProductRef; quantity: number }>): Promise<BatchResult>;
  updatePrices(updates: Array<{ ref: StoreProductRef; priceMinor: number }>): Promise<BatchResult>;
  createProduct(product: NewStoreProduct): Promise<StoreProductRef>;
}

export interface AccountingConnector extends WebhookAware {
  readonly provider: AccountingProvider;
  /** finds a customer by email/phone or creates one, returns the provider id */
  upsertCustomer(customer: Customer): Promise<string>;
  /** idempotency at the provider level: look up a document we may have created before */
  findSalesDocument(externalRef: string): Promise<DocumentRef | null>;
  createSalesDocument(input: SalesDocumentInput): Promise<DocumentRef>;
  registerPayment(input: PaymentInput): Promise<DocumentRef>;
  listProducts(): Promise<CatalogProduct[]>;
  getStock(warehouseId: string | null): Promise<StockLevel[]>;
  listWarehouses(): Promise<NamedRef[]>;
  listOrderStatuses(): Promise<NamedRef[]>;
  listTaxRates(): Promise<TaxRate[]>;
}

export interface StoreConnectorFactory {
  readonly provider: StoreProvider;
  readonly kind: 'store';
  create(ctx: ConnectorContext): StoreConnector;
}

export interface AccountingConnectorFactory {
  readonly provider: AccountingProvider;
  readonly kind: 'accounting';
  create(ctx: ConnectorContext): AccountingConnector;
}

export type ConnectorFactory = StoreConnectorFactory | AccountingConnectorFactory;
