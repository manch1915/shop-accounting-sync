export const STORE_PROVIDERS = ['woocommerce', 'shopify'] as const;
export const ACCOUNTING_PROVIDERS = ['moysklad', 'xero'] as const;
export const PROVIDERS = [...STORE_PROVIDERS, ...ACCOUNTING_PROVIDERS] as const;

export type StoreProvider = (typeof STORE_PROVIDERS)[number];
export type AccountingProvider = (typeof ACCOUNTING_PROVIDERS)[number];
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_NAMES: Record<Provider, string> = {
  woocommerce: 'WooCommerce',
  shopify: 'Shopify',
  moysklad: 'МойСклад',
  xero: 'Xero',
};

export const OPERATION_TYPES = [
  'order.export',
  'payment.export',
  'stock.push',
  'price.push',
  'product.publish',
  'orders.reconcile',
  'catalog.refresh',
] as const;
export type OperationType = (typeof OPERATION_TYPES)[number];

/**
 * queued -> running -> succeeded
 *                   -> retrying -> running ...
 *                   -> blocked (waits for a mapping conflict to be resolved)
 *                   -> dead (retries exhausted or the provider rejected the data)
 * skipped: duplicate delivery or nothing to do.
 */
export const OPERATION_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'retrying',
  'blocked',
  'dead',
  'skipped',
] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export const CONNECTION_STATUSES = ['active', 'degraded', 'error', 'disconnected'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const CONFLICT_KINDS = [
  'sku_not_mapped',
  'tax_not_mapped',
  'status_not_mapped',
  'duplicate_sku',
] as const;
export type ConflictKind = (typeof CONFLICT_KINDS)[number];

export const MATCH_METHODS = ['sku', 'barcode', 'manual'] as const;
export type MatchMethod = (typeof MATCH_METHODS)[number];

export const ROLES = ['owner', 'viewer'] as const;
export type Role = (typeof ROLES)[number];
