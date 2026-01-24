import { describeError, type ErrorCode, type Provider } from '@sas/shared';
import type { Locale } from './i18n';

const NAMES: Record<Provider, string> = {
  woocommerce: 'WooCommerce',
  shopify: 'Shopify',
  moysklad: 'МойСклад',
  xero: 'Xero',
};

export function errorText(
  code: ErrorCode,
  params: Record<string, string | number> | null,
  locale: Locale,
): { title: string; hint: string } {
  const values = { ...(params ?? {}) };
  if (typeof values.provider === 'string' && values.provider in NAMES) {
    values.provider = NAMES[values.provider as Provider];
  }
  return describeError(code, values, locale);
}
