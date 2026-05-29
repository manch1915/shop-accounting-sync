// End to end through the real pieces: HTTP webhook -> Nest API -> BullMQ worker -> connectors ->
// sandbox WooCommerce and МойСклад. Needs Postgres and Redis (CI runs them as services).
import { createHmac, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSandbox, type Sandbox } from '../../../sandbox/src/app.js';
import { testConfig } from '../../../sandbox/src/testing/harness.js';

const TOKEN = 'pipeline-test-token';
const RUN = randomBytes(3).toString('hex');
const IDS = {
  workspace: `ws_pipe_${RUN}`,
  integration: `int_pipe_${RUN}`,
  store: `conn_pipe_woo_${RUN}`,
  accounting: `conn_pipe_ms_${RUN}`,
};

process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
process.env.SESSION_SECRET ??= randomBytes(32).toString('base64');
process.env.DATABASE_URL ??= 'postgresql://sync:sync@localhost:5433/sync';
process.env.REDIS_URL ??= 'redis://localhost:6380';
process.env.APP_ROLE = 'all';
// own queues, so a dev worker running on the same Redis cannot pick up these jobs
process.env.QUEUE_PREFIX = `test-${RUN}`;
process.env.SCHEDULES_ENABLED = 'false';

let sandbox: Sandbox;
let sandboxServer: ReturnType<typeof serve>;
let app: INestApplication;
let apiUrl: string;
// loaded after env is set: CoreModule reads the config on import
let prisma: import('../../src/infra/prisma.service.js').PrismaService;

async function waitFor<T>(probe: () => Promise<T | null | undefined>, timeoutMs = 20_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await probe();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('timed out waiting for the pipeline');
}

async function sendOrderWebhook(orderId: number, deliveryId: string) {
  const body = JSON.stringify({ id: orderId });
  const signature = createHmac('sha256', TOKEN).update(body).digest('base64');
  const res = await fetch(`${apiUrl}/webhooks/${IDS.store}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-wc-webhook-topic': 'order.created',
      'x-wc-webhook-delivery-id': deliveryId,
      'x-wc-webhook-signature': signature,
    },
    body,
  });
  return {
    status: res.status,
    body: (await res.json()) as { received: number; duplicates: number; queued: number },
  };
}

beforeAll(async () => {
  sandbox = createSandbox(testConfig({ token: TOKEN }));
  sandboxServer = serve({ fetch: sandbox.app.fetch, port: 0 });
  await new Promise((r) => sandboxServer.once('listening', r));
  const sandboxUrl = `http://127.0.0.1:${(sandboxServer.address() as AddressInfo).port}`;

  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../../src/app.module.js');
  const { PrismaService } = await import('../../src/infra/prisma.service.js');
  const { CredentialCipher } = await import('../../src/security/credential-cipher.js');

  app = await NestFactory.create(AppModule.forRole('all'), { rawBody: true, logger: false });
  await app.listen(0, '127.0.0.1');
  apiUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  prisma = app.get(PrismaService);
  const cipher = app.get(CredentialCipher);

  await prisma.workspace.create({
    data: {
      id: IDS.workspace,
      name: 'Pipeline test',
      connections: {
        create: [
          {
            id: IDS.store,
            name: 'Test WooCommerce',
            provider: 'woocommerce',
            kind: 'store',
            authType: 'basic',
            baseUrl: `${sandboxUrl}/woo/wp-json/wc/v3`,
            credentials: cipher.encryptJson({ consumerKey: 'ck_sandbox', consumerSecret: TOKEN }),
            webhookSecret: cipher.encrypt(TOKEN),
            settings: { currency: 'RUB' },
          },
          {
            id: IDS.accounting,
            name: 'Test МойСклад',
            provider: 'moysklad',
            kind: 'accounting',
            authType: 'api_key',
            baseUrl: `${sandboxUrl}/moysklad/api/remap/1.2`,
            credentials: cipher.encryptJson({ token: TOKEN }),
            webhookSecret: cipher.encrypt(TOKEN),
            settings: { currency: 'RUB', organizationId: sandbox.state.moysklad.organization.id },
          },
        ],
      },
    },
  });
  await prisma.integration.create({
    data: {
      id: IDS.integration,
      workspaceId: IDS.workspace,
      name: 'Pipeline test',
      storeConnectionId: IDS.store,
      accountingConnectionId: IDS.accounting,
      currency: 'RUB',
      flags: {
        exportOrders: true,
        exportPayments: true,
        pushStock: false,
        pushPrices: false,
        publishNewProducts: false,
      },
      settings: { refPrefix: `t${RUN}` },
    },
  });

  // a fresh integration starts with a catalog refresh; it links items whose SKU differs between
  // the shop and accounting by barcode, which orders may contain
  const { SchedulerService } = await import('../../src/sync/scheduler.service.js');
  await app.get(SchedulerService).fire({ integrationId: IDS.integration, type: 'catalog.refresh' });
  await waitFor(() =>
    prisma.operation.findFirst({
      where: { integrationId: IDS.integration, type: 'catalog.refresh', status: 'succeeded' },
    }),
  );
}, 60_000);

afterAll(async () => {
  await prisma?.workspace.deleteMany({ where: { id: IDS.workspace } });
  await app?.close();
  sandboxServer?.close();
});

describe('order pipeline (needs Postgres and Redis)', () => {
  it('turns a paid store order into an order and a payment in МойСклад', async () => {
    const { order } = sandbox.generator.factory.createZernoOrder({ payment: 'paid', withStoreOnly: false });
    const res = await sendOrderWebhook(order.id, `d-${RUN}-1`);
    expect(res).toMatchObject({ status: 200, body: { received: 1, queued: 1 } });

    const exported = await waitFor(() =>
      prisma.operation.findFirst({
        where: {
          integrationId: IDS.integration,
          type: 'order.export',
          subjectRef: String(order.id),
          status: 'succeeded',
        },
      }),
    );
    expect(exported.attempts).toBe(1);

    await waitFor(() =>
      prisma.operation.findFirst({
        where: {
          integrationId: IDS.integration,
          type: 'payment.export',
          subjectRef: String(order.id),
          status: 'succeeded',
        },
      }),
    );
    const documents = [...sandbox.state.moysklad.orders.values()].filter(
      (o) => o.externalCode === `t${RUN}-${order.id}`,
    );
    expect(documents).toHaveLength(1);
    expect(sandbox.state.moysklad.payments.size).toBeGreaterThan(0);

    const exchanges = await prisma.httpExchange.count({ where: { operationId: exported.id } });
    expect(exchanges).toBeGreaterThanOrEqual(3);
  }, 30_000);

  it('drops a repeated delivery and never creates a second document', async () => {
    const { order } = sandbox.generator.factory.createZernoOrder({
      payment: 'pending',
      withStoreOnly: false,
    });
    await sendOrderWebhook(order.id, `d-${RUN}-2`);
    const again = await sendOrderWebhook(order.id, `d-${RUN}-2`);
    expect(again.body).toMatchObject({ received: 1, duplicates: 1, queued: 0 });

    await waitFor(() =>
      prisma.operation.findFirst({
        where: { integrationId: IDS.integration, subjectRef: String(order.id), status: 'succeeded' },
      }),
    );
    // a fresh delivery id for the same order (a store re-sending) is deduplicated by the operation key
    const third = await sendOrderWebhook(order.id, `d-${RUN}-3`);
    expect(third.body.queued).toBe(0);
    const documents = [...sandbox.state.moysklad.orders.values()].filter(
      (o) => o.externalCode === `t${RUN}-${order.id}`,
    );
    expect(documents).toHaveLength(1);
  }, 30_000);

  it('holds an order with an unknown SKU on a conflict instead of failing it', async () => {
    const { order } = sandbox.generator.factory.createZernoOrder({ payment: 'paid', withStoreOnly: true });
    await sendOrderWebhook(order.id, `d-${RUN}-4`);
    const blocked = await waitFor(() =>
      prisma.operation.findFirst({
        where: { integrationId: IDS.integration, subjectRef: String(order.id), status: 'blocked' },
        include: { conflict: true },
      }),
    );
    expect(blocked.errorCode).toBe('sku_not_mapped');
    expect(blocked.conflict).toMatchObject({ kind: 'sku_not_mapped', status: 'open' });
  }, 30_000);
});
