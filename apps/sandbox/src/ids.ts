import { createHash, randomBytes } from 'node:crypto';

// МойСклад ids look like time-based UUIDs with a fixed node part; ours are hashes in the same shape,
// so a product keeps its id across restarts and the API's mappings stay valid.
function moyskladShape(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-11f1-0a80-${hex.slice(12, 24)}`;
}

function v4Shape(hex: string): string {
  const variant = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function hash(name: string): string {
  return createHash('sha1').update(name).digest('hex');
}

export const msId = (name: string): string => moyskladShape(hash(`moysklad:${name}`));
export const xeroId = (name: string): string => v4Shape(hash(`xero:${name}`));
export const newMsId = (): string => moyskladShape(randomBytes(12).toString('hex'));
export const newXeroId = (): string => v4Shape(randomBytes(16).toString('hex'));
export const newUuid = (): string => v4Shape(randomBytes(16).toString('hex'));

export const MOYSKLAD = {
  accountId: msId('account'),
  organizationId: msId('organization'),
  mainStoreId: msId('store:main'),
  cafeStoreId: msId('store:cafe'),
  priceTypeId: msId('pricetype:sale'),
  currencyId: msId('currency:rub'),
};

export const XERO = {
  tenantId: xeroId('tenant:hillside'),
  clientId: 'sandbox-client',
};

export const SHOPIFY = {
  shopDomain: 'hillside-tea.myshopify.com',
  locationId: '76543210987',
  apiVersion: '2026-10',
};

export const WOOCOMMERCE = {
  consumerKey: 'ck_sandbox',
  siteUrl: 'https://zerno-i-par.example',
  webhookId: 14,
};

const EPOCH = Date.UTC(2026, 0, 1);

/** order numbers grow with wall-clock time, so a restarted sandbox never reuses an old one */
export function orderNumberBase(now = Date.now()): number {
  return 10_000 + Math.floor((now - EPOCH) / 60_000);
}
