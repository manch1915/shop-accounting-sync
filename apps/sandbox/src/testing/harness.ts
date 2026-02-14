// Runs the API's real connector classes against an in-process sandbox, so a change on either
// side that breaks the contract fails here.
import { DEMO_IDS } from '@sas/demo-data';
import type { Provider } from '@sas/shared';
import { type ErrorPolicy, HttpClient } from '../../../api/src/connectors/http/http-client.js';
import {
  MoySkladConnector,
  moySkladErrorPolicy,
} from '../../../api/src/connectors/moysklad/moysklad.connector.js';
import {
  ShopifyConnector,
  shopifyErrorPolicy,
} from '../../../api/src/connectors/shopify/shopify.connector.js';
import {
  WooCommerceConnector,
  wooErrorPolicy,
} from '../../../api/src/connectors/woocommerce/woocommerce.connector.js';
import { XeroConnector, xeroErrorPolicy } from '../../../api/src/connectors/xero/xero.connector.js';
import type { ConnectorContext, Credentials } from '../../../api/src/domain/connectors.js';
import { connectionSettings, createSandbox, type Sandbox, type SandboxOverrides } from '../app.js';
import type { SandboxConfig } from '../config.js';
import { seededRandom } from '../random.js';

export const TEST_URL = 'http://sandbox.test';
export const TEST_TOKEN = 'contract-test-token';

export function testConfig(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    port: 0,
    publicUrl: TEST_URL,
    token: TEST_TOKEN,
    webhookTarget: 'http://api.test',
    generator: false,
    generatorMinSec: 20,
    generatorMaxSec: 70,
    faultRate: 0,
    slowResponseMs: 16_000,
    ...overrides,
  };
}

export interface Harness {
  sandbox: Sandbox;
  fetchImpl: typeof fetch;
  woo(credentials?: Partial<Credentials>): WooCommerceConnector;
  shopify(credentials?: Partial<Credentials>): ShopifyConnector;
  moysklad(credentials?: Partial<Credentials>): MoySkladConnector;
  xero(
    credentials?: Partial<Credentials>,
    onRefresh?: ConnectorContext['onCredentialsRefreshed'],
  ): XeroConnector;
}

export function harness(config: Partial<SandboxConfig> = {}, overrides: SandboxOverrides = {}): Harness {
  const cfg = testConfig(config);
  const sandbox = createSandbox(cfg, { random: seededRandom(42), retryDelaysMs: [0, 0], ...overrides });
  const fetchImpl: typeof fetch = async (input, init) => sandbox.app.fetch(new Request(input, init));
  const connections = connectionSettings(cfg);

  function context(
    id: keyof typeof connections,
    provider: Provider,
    policy: ErrorPolicy,
    credentials: Partial<Credentials>,
    onCredentialsRefreshed?: ConnectorContext['onCredentialsRefreshed'],
  ): ConnectorContext {
    const conn = connections[id];
    if (!conn) throw new Error(`no sandbox connection ${String(id)}`);
    const http = new HttpClient({
      provider,
      connectionId: String(id),
      baseUrl: conn.baseUrl,
      timeoutMs: 2_000,
      sink: { record: () => {} },
      policy,
      fetchImpl,
    });
    return {
      connectionId: String(id),
      baseUrl: conn.baseUrl,
      credentials: { ...conn.credentials, ...credentials } as Credentials,
      settings: conn.settings,
      http,
      onCredentialsRefreshed,
    };
  }

  return {
    sandbox,
    fetchImpl,
    woo: (c = {}) =>
      new WooCommerceConnector(context(DEMO_IDS.zerno.store, 'woocommerce', wooErrorPolicy, c)),
    shopify: (c = {}) =>
      new ShopifyConnector(context(DEMO_IDS.hillside.store, 'shopify', shopifyErrorPolicy, c)),
    moysklad: (c = {}) =>
      new MoySkladConnector(context(DEMO_IDS.zerno.accounting, 'moysklad', moySkladErrorPolicy, c)),
    xero: (c = {}, onRefresh) =>
      new XeroConnector(context(DEMO_IDS.hillside.accounting, 'xero', xeroErrorPolicy, c, onRefresh)),
  };
}
