import { DEMO_IDS, SANDBOX_PATHS } from '@sas/demo-data';
import { Hono } from 'hono';
import type { SandboxConfig } from './config.js';
import { createFaultSettings, type FaultSettings } from './faults.js';
import { Generator } from './generator.js';
import { MOYSKLAD, SHOPIFY, WOOCOMMERCE, XERO } from './ids.js';
import { moySkladApp } from './providers/moysklad.js';
import { shopifyApp } from './providers/shopify.js';
import { wooCommerceApp } from './providers/woocommerce.js';
import { xeroApp, xeroIdentityApp } from './providers/xero.js';
import { createRandom, type Random } from './random.js';
import { createState, type SandboxState } from './state/sandbox.js';
import { renderStatusPage } from './ui.js';
import { WebhookSender } from './webhooks.js';

export interface Sandbox {
  app: Hono;
  state: SandboxState;
  faults: FaultSettings;
  generator: Generator;
  sender: WebhookSender;
}

export interface SandboxOverrides {
  random?: Random;
  fetchImpl?: typeof fetch;
  retryDelaysMs?: number[];
}

export function createSandbox(config: SandboxConfig, overrides: SandboxOverrides = {}): Sandbox {
  const random = overrides.random ?? createRandom();
  const state = createState(config.token);
  const faults = createFaultSettings(config.faultRate, config.slowResponseMs);
  const sender = new WebhookSender({
    target: config.webhookTarget,
    log: state.activity,
    retryDelaysMs: overrides.retryDelaysMs,
    fetchImpl: overrides.fetchImpl,
  });
  const generator = new Generator({ state, sender, random, config });
  const app = new Hono();

  app.get('/', (c) => c.html(renderStatusPage(state, faults, config.generator)));
  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      uptimeSec: Math.round((Date.now() - state.startedAt.getTime()) / 1000),
      generator: config.generator,
      faultRate: faults.rate,
    }),
  );
  // ready-made connection settings for the API seed
  app.get('/connections', (c) => c.json(connectionSettings(config)));

  app.route(SANDBOX_PATHS.woocommerce, wooCommerceApp(state, config.token));
  app.route(SANDBOX_PATHS.shopify, shopifyApp(state, config.token));
  app.route(SANDBOX_PATHS.moysklad, moySkladApp(state, config.token, faults, random));
  app.route(SANDBOX_PATHS.xero, xeroApp(state, faults, random));
  app.route(SANDBOX_PATHS.xeroIdentity, xeroIdentityApp(state, config.token));

  return { app, state, faults, generator, sender };
}

export function connectionSettings(config: Pick<SandboxConfig, 'publicUrl' | 'token'>) {
  const url = config.publicUrl;
  const token = config.token;
  return {
    [DEMO_IDS.zerno.store]: {
      provider: 'woocommerce',
      baseUrl: `${url}${SANDBOX_PATHS.woocommerce}`,
      credentials: { consumerKey: WOOCOMMERCE.consumerKey, consumerSecret: token },
      webhookSecret: token,
      settings: { currency: 'RUB', siteUrl: WOOCOMMERCE.siteUrl },
    },
    [DEMO_IDS.zerno.accounting]: {
      provider: 'moysklad',
      baseUrl: `${url}${SANDBOX_PATHS.moysklad}`,
      credentials: { token },
      webhookSecret: token,
      settings: { currency: 'RUB', organizationId: MOYSKLAD.organizationId, timezone: 'Europe/Moscow' },
      warehouses: { main: MOYSKLAD.mainStoreId, cafe: MOYSKLAD.cafeStoreId },
    },
    [DEMO_IDS.hillside.store]: {
      provider: 'shopify',
      baseUrl: `${url}${SANDBOX_PATHS.shopify}`,
      credentials: { accessToken: token },
      webhookSecret: token,
      settings: { currency: 'GBP', locationId: SHOPIFY.locationId, shopDomain: SHOPIFY.shopDomain },
    },
    [DEMO_IDS.hillside.accounting]: {
      provider: 'xero',
      baseUrl: `${url}${SANDBOX_PATHS.xero}`,
      credentials: {
        accessToken: token,
        refreshToken: token,
        clientId: XERO.clientId,
        clientSecret: token,
        tenantId: XERO.tenantId,
      },
      settings: { currency: 'GBP', identityUrl: `${url}${SANDBOX_PATHS.xeroIdentity}` },
    },
  };
}
