import type { AccountingProvider, Provider, StoreProvider } from '@sas/shared';
import type {
  AccountingConnectorFactory,
  ConnectorFactory,
  StoreConnectorFactory,
} from '../domain/connectors.js';
import type { ErrorPolicy } from './http/http-client.js';
import { moySkladErrorPolicy, moySkladFactory } from './moysklad/moysklad.connector.js';
import { shopifyErrorPolicy, shopifyFactory } from './shopify/shopify.connector.js';
import { wooCommerceFactory, wooErrorPolicy } from './woocommerce/woocommerce.connector.js';
import { xeroErrorPolicy, xeroFactory } from './xero/xero.connector.js';

// Adding a provider: implement StoreConnector or AccountingConnector, export a factory and an
// ErrorPolicy, register both here. Nothing else in the sync engine needs to change.
const STORE: Record<StoreProvider, StoreConnectorFactory> = {
  woocommerce: wooCommerceFactory,
  shopify: shopifyFactory,
};

const ACCOUNTING: Record<AccountingProvider, AccountingConnectorFactory> = {
  moysklad: moySkladFactory,
  xero: xeroFactory,
};

const POLICIES: Record<Provider, ErrorPolicy> = {
  woocommerce: wooErrorPolicy,
  shopify: shopifyErrorPolicy,
  moysklad: moySkladErrorPolicy,
  xero: xeroErrorPolicy,
};

export function storeFactory(provider: string): StoreConnectorFactory {
  const factory = STORE[provider as StoreProvider];
  if (!factory) throw new Error(`Unknown store provider: ${provider}`);
  return factory;
}

export function accountingFactory(provider: string): AccountingConnectorFactory {
  const factory = ACCOUNTING[provider as AccountingProvider];
  if (!factory) throw new Error(`Unknown accounting provider: ${provider}`);
  return factory;
}

export function anyFactory(provider: string): ConnectorFactory {
  return provider in STORE ? storeFactory(provider) : accountingFactory(provider);
}

export function errorPolicy(provider: string): ErrorPolicy {
  const policy = POLICIES[provider as Provider];
  if (!policy) throw new Error(`Unknown provider: ${provider}`);
  return policy;
}
