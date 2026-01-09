// Demo workspace: two shops wired to the sandbox, plus 30 days of history so the charts and the
// log are not empty on first open. Safe to re-run: it wipes the demo workspace first.
import { randomBytes } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  DEMO_IDS,
  type DemoCustomer,
  type DemoProduct,
  HILLSIDE_PRODUCTS,
  RU_CUSTOMERS,
  SANDBOX_PATHS,
  UK_CUSTOMERS,
  ZERNO_PRODUCTS,
} from '@sas/demo-data';
import { config } from 'dotenv';
import { DEMO_EMAIL, OWNER_EMAIL } from '../src/auth/accounts.js';
import { hashPassword } from '../src/auth/session-token.js';
import { Prisma, PrismaClient } from '../src/generated/prisma/client.js';
import { CredentialCipher } from '../src/security/credential-cipher.js';

config({ path: ['.env', '../../.env'], quiet: true });

const env = (key: string, fallback?: string) => {
  const value = process.env[key] ?? fallback;
  if (value === undefined) throw new Error(`${key} is not set`);
  return value;
};

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env('DATABASE_URL') }) });
const cipher = new CredentialCipher(env('ENCRYPTION_KEY'));
const sandbox = env('SANDBOX_URL', 'http://localhost:4010').replace(/\/$/, '');
const token = env('SANDBOX_TOKEN', 'sandbox-demo-token');
const HISTORY_DAYS = 30;

// deterministic randomness, so every reseed tells the same story
let seed = 20261019;
function rand(): number {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}
const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
const between = (min: number, max: number) => min + rand() * (max - min);

interface ShopPlan {
  integrationId: string;
  storeConnectionId: string;
  accountingConnectionId: string;
  storeProvider: 'woocommerce' | 'shopify';
  accountingProvider: 'moysklad' | 'xero';
  prefix: string;
  currency: string;
  products: DemoProduct[];
  customers: DemoCustomer[];
  ordersPerDay: [number, number];
  firstOrderId: number;
}

const ZERNO: ShopPlan = {
  integrationId: DEMO_IDS.zerno.integration,
  storeConnectionId: DEMO_IDS.zerno.store,
  accountingConnectionId: DEMO_IDS.zerno.accounting,
  storeProvider: 'woocommerce',
  accountingProvider: 'moysklad',
  prefix: 'woo',
  currency: 'RUB',
  products: ZERNO_PRODUCTS.filter((p) => !p.accountingOnly && !p.storeOnly),
  customers: RU_CUSTOMERS,
  ordersPerDay: [18, 34],
  firstOrderId: 4200,
};

const HILLSIDE: ShopPlan = {
  integrationId: DEMO_IDS.hillside.integration,
  storeConnectionId: DEMO_IDS.hillside.store,
  accountingConnectionId: DEMO_IDS.hillside.accounting,
  storeProvider: 'shopify',
  accountingProvider: 'xero',
  prefix: 'shop',
  currency: 'GBP',
  products: HILLSIDE_PRODUCTS.filter((p) => !p.accountingOnly && !p.storeOnly),
  customers: UK_CUSTOMERS,
  ordersPerDay: [10, 22],
  firstOrderId: 1840,
};

async function reset(): Promise<void> {
  await prisma.workspace.deleteMany({ where: { id: DEMO_IDS.workspace } });
}

async function workspace(): Promise<void> {
  const ownerPassword = process.env.SEED_OWNER_PASSWORD || randomBytes(9).toString('base64url');
  await prisma.workspace.create({
    data: {
      id: DEMO_IDS.workspace,
      name: 'Demo: two shops',
      users: {
        create: [
          {
            email: OWNER_EMAIL,
            name: 'Shop owner',
            role: 'owner',
            passwordHash: await hashPassword(ownerPassword),
          },
          {
            email: DEMO_EMAIL,
            name: 'Demo visitor',
            role: 'viewer',
            // the demo account signs in through /auth/demo only
            passwordHash: await hashPassword(randomBytes(24).toString('hex')),
          },
        ],
      },
    },
  });
  if (!process.env.SEED_OWNER_PASSWORD) {
    console.log(`Owner login: owner@shop-sync.dev / ${ownerPassword}`);
  }
}

async function connections(): Promise<void> {
  const secret = cipher.encrypt(token);
  const rows: Array<Omit<Prisma.ConnectionCreateManyInput, 'workspaceId'>> = [
    {
      id: DEMO_IDS.zerno.store,
      name: 'Зерно и Пар · WooCommerce',
      provider: 'woocommerce',
      kind: 'store',
      authType: 'basic',
      baseUrl: `${sandbox}${SANDBOX_PATHS.woocommerce}`,
      credentials: cipher.encryptJson({ consumerKey: 'ck_sandbox', consumerSecret: token }),
      webhookSecret: secret,
      settings: { currency: 'RUB', siteUrl: `${sandbox}/woo` },
    },
    {
      id: DEMO_IDS.zerno.accounting,
      name: 'Зерно и Пар · МойСклад',
      provider: 'moysklad',
      kind: 'accounting',
      authType: 'api_key',
      baseUrl: `${sandbox}${SANDBOX_PATHS.moysklad}`,
      credentials: cipher.encryptJson({ token }),
      webhookSecret: secret,
      settings: {
        currency: 'RUB',
        organizationId: 'org-zerno-i-par',
        uiUrl: `${sandbox}/moysklad/app`,
      },
    },
    {
      id: DEMO_IDS.hillside.store,
      name: 'Hillside Tea Co. · Shopify',
      provider: 'shopify',
      kind: 'store',
      authType: 'oauth2',
      baseUrl: `${sandbox}${SANDBOX_PATHS.shopify}`,
      credentials: cipher.encryptJson({ accessToken: token }),
      webhookSecret: secret,
      settings: {
        currency: 'GBP',
        shopDomain: 'hillside-tea.myshopify.com',
        locationId: 'gid://shopify/Location/71003',
      },
    },
    {
      id: DEMO_IDS.hillside.accounting,
      name: 'Hillside Tea Co. · Xero',
      provider: 'xero',
      kind: 'accounting',
      authType: 'oauth2',
      baseUrl: `${sandbox}${SANDBOX_PATHS.xero}`,
      credentials: cipher.encryptJson({
        accessToken: token,
        refreshToken: `rt-${randomBytes(8).toString('hex')}`,
        clientId: 'sandbox-client',
        clientSecret: token,
        tenantId: 'hillside-demo-tenant',
        expiresAt: new Date(Date.now() + 25 * 60_000).toISOString(),
      }),
      tokenExpiresAt: new Date(Date.now() + 25 * 60_000),
      webhookSecret: secret,
      settings: {
        currency: 'GBP',
        identityUrl: `${sandbox}${SANDBOX_PATHS.xeroIdentity}`,
        salesAccountCode: '200',
        shippingAccountCode: '260',
        paymentAccountCode: '090',
      },
    },
  ];
  await prisma.connection.createMany({
    data: rows.map((r) => ({ ...r, workspaceId: DEMO_IDS.workspace, lastSyncAt: new Date() })),
  });

  const allFlags = {
    exportOrders: true,
    exportPayments: true,
    pushStock: true,
    pushPrices: true,
    publishNewProducts: false,
  };
  await prisma.integration.createMany({
    data: [
      {
        id: DEMO_IDS.zerno.integration,
        workspaceId: DEMO_IDS.workspace,
        name: 'Зерно и Пар',
        storeConnectionId: DEMO_IDS.zerno.store,
        accountingConnectionId: DEMO_IDS.zerno.accounting,
        currency: 'RUB',
        flags: allFlags,
        reconcileEveryMin: 10,
        settings: { refPrefix: 'woo' },
      },
      {
        id: DEMO_IDS.hillside.integration,
        workspaceId: DEMO_IDS.workspace,
        name: 'Hillside Tea Co.',
        storeConnectionId: DEMO_IDS.hillside.store,
        accountingConnectionId: DEMO_IDS.hillside.accounting,
        currency: 'GBP',
        flags: { ...allFlags, publishNewProducts: true },
        reconcileEveryMin: 15,
        settings: { refPrefix: 'shop' },
      },
    ],
  });

  await prisma.valueMapping.createMany({
    data: [
      {
        integrationId: ZERNO.integrationId,
        kind: 'status',
        source: 'processing',
        sourceLabel: 'В обработке',
        target: 'state-confirmed',
        targetLabel: 'Подтверждён',
      },
      {
        integrationId: ZERNO.integrationId,
        kind: 'status',
        source: 'on-hold',
        sourceLabel: 'На удержании',
        target: 'state-new',
        targetLabel: 'Новый',
      },
      {
        integrationId: ZERNO.integrationId,
        kind: 'status',
        source: 'completed',
        sourceLabel: 'Выполнен',
        target: 'state-shipped',
        targetLabel: 'Отгружен',
      },
      {
        integrationId: ZERNO.integrationId,
        kind: 'warehouse',
        source: 'default',
        sourceLabel: 'Остатки сайта',
        target: 'store-main',
        targetLabel: 'Основной склад',
      },
      {
        integrationId: HILLSIDE.integrationId,
        kind: 'warehouse',
        source: 'gid://shopify/Location/71003',
        sourceLabel: 'Harrogate studio',
        target: 'default',
        targetLabel: 'Xero tracked inventory',
      },
      {
        integrationId: HILLSIDE.integrationId,
        kind: 'tax',
        source: '20',
        sourceLabel: '20%',
        target: 'OUTPUT2',
        targetLabel: '20% (VAT on Income)',
      },
    ],
  });
}

// ---------------------------------------------------------------- history

interface HistoryOp {
  op: Prisma.OperationCreateManyInput;
  events: Array<{ level: string; message: string; offsetMs: number }>;
  exchanges: Array<
    Omit<Prisma.HttpExchangeCreateManyInput, 'operationId' | 'createdAt'> & { offsetMs: number }
  >;
}

let opCounter = 0;
const opId = () => `hist_${(opCounter++).toString(36).padStart(6, '0')}`;

function orderLines(plan: ShopPlan) {
  const count = 1 + Math.floor(rand() * rand() * 4);
  const lines = Array.from({ length: count }, () => {
    const product = pick(plan.products);
    return { product, quantity: 1 + Math.floor(rand() * rand() * 3) };
  });
  const total = lines.reduce((s, l) => s + l.product.priceMinor * l.quantity, 0);
  return { lines, total };
}

function money(minor: number, currency: string): string {
  return (minor / 100).toLocaleString(currency === 'RUB' ? 'ru-RU' : 'en-GB', {
    style: 'currency',
    currency,
  });
}

function exchange(
  connectionId: string,
  method: string,
  url: string,
  status: number,
  durationMs: number,
  offsetMs: number,
  requestBody: unknown,
  responseBody: unknown,
  attempt = 1,
): HistoryOp['exchanges'][number] {
  return {
    connectionId,
    attempt,
    method,
    url,
    requestHeaders: { accept: 'application/json', authorization: 'Bearer ••••oken' },
    requestBody: requestBody === null ? null : JSON.stringify(requestBody, null, 2),
    status,
    responseHeaders: { 'content-type': 'application/json' },
    responseBody: responseBody === null ? null : JSON.stringify(responseBody, null, 2),
    durationMs: Math.round(durationMs),
    error: null,
    offsetMs,
  };
}

function orderHistory(plan: ShopPlan, orderId: number, created: Date): HistoryOp[] {
  const { lines, total } = orderLines(plan);
  const customer = pick(plan.customers);
  const accounting = plan.accountingProvider;
  const store = `${sandbox}${plan.storeProvider === 'woocommerce' ? SANDBOX_PATHS.woocommerce : SANDBOX_PATHS.shopify}`;
  const acc = `${sandbox}${accounting === 'moysklad' ? SANDBOX_PATHS.moysklad : SANDBOX_PATHS.xero}`;
  const docId = `${accounting === 'moysklad' ? 'ms' : 'inv'}-${plan.prefix}-${orderId}`;
  const docNumber = accounting === 'moysklad' ? String(orderId) : `WEB-${orderId}`;
  const docUrl =
    accounting === 'moysklad'
      ? `${sandbox}/moysklad/app/#customerorder/edit?id=${docId}`
      : `${sandbox}/xero/AccountsReceivable/View.aspx?InvoiceID=${docId}`;

  // most orders sync in a couple of seconds; some hit a rate limit or a 503 and take longer
  const roll = rand();
  const outcome = roll < 0.9 ? 'clean' : roll < 0.965 ? 'retried' : roll < 0.985 ? 'blocked' : 'dead';
  const fetchMs = between(120, 420);
  // blocked orders waited for someone to add the mapping; stats leave that wait out
  const waitedMs = outcome === 'blocked' ? between(600_000, 7_200_000) : 0;
  const docMs = between(250, 900);
  const queueMs = between(300, 1600);
  const retryDelay = outcome === 'retried' ? between(4_000, 45_000) : 0;
  const totalMs = queueMs + fetchMs + docMs + between(80, 300) + retryDelay;

  const exchanges: HistoryOp['exchanges'] = [
    exchange(
      plan.storeConnectionId,
      plan.storeProvider === 'shopify' ? 'POST' : 'GET',
      plan.storeProvider === 'shopify' ? store : `${store}/orders/${orderId}`,
      200,
      fetchMs,
      queueMs,
      plan.storeProvider === 'shopify'
        ? {
            query: 'query Order($id: ID!) { order(id: $id) { ...OrderFields } }',
            variables: { id: `gid://shopify/Order/${orderId}` },
          }
        : null,
      {
        id: orderId,
        number: String(orderId),
        currency: plan.currency,
        total: (total / 100).toFixed(2),
        line_items: lines.map((l) => ({ sku: l.product.sku, name: l.product.name, quantity: l.quantity })),
      },
    ),
  ];
  const events: HistoryOp['events'] = [
    {
      level: 'info',
      message: `Fetched order ${orderId}: ${lines.length} lines, ${plan.currency}`,
      offsetMs: queueMs + fetchMs,
    },
  ];

  if (outcome === 'retried') {
    const limited = rand() < 0.6;
    exchanges.push(
      exchange(
        plan.accountingConnectionId,
        'POST',
        `${acc}/${accounting === 'moysklad' ? 'entity/customerorder' : 'Invoices'}`,
        limited ? 429 : 503,
        between(40, 200),
        queueMs + fetchMs + 50,
        { externalRef: `${plan.prefix}-${orderId}` },
        limited
          ? accounting === 'moysklad'
            ? {
                errors: [
                  { error: 'Превышено ограничение на количество запросов в единицу времени', code: 1049 },
                ],
              }
            : { Title: 'Too Many Requests', Detail: 'Minute rate limit exceeded' }
          : { message: 'Service Unavailable' },
      ),
    );
    events.push({
      level: 'warn',
      message: limited
        ? `Rate limited, continuing in ${Math.ceil(retryDelay / 1000)} s`
        : `${accounting} unavailable (503). Retrying in about ${Math.ceil(retryDelay / 1000)} s`,
      offsetMs: queueMs + fetchMs + 300,
    });
  }

  if (outcome === 'blocked' || outcome === 'dead') {
    const failAt = queueMs + fetchMs + docMs;
    if (outcome === 'dead') {
      exchanges.push(
        exchange(
          plan.accountingConnectionId,
          accounting === 'xero' ? 'PUT' : 'POST',
          `${acc}/${accounting === 'xero' ? 'Invoices' : 'entity/customerorder'}`,
          400,
          docMs,
          failAt - docMs,
          { reference: `${plan.prefix}-${orderId}` },
          accounting === 'xero'
            ? {
                Type: 'ValidationException',
                Message: 'A validation exception occurred',
                Elements: [
                  {
                    ValidationErrors: [
                      { Message: 'The document total exceeds the limit allowed for this demo organisation' },
                    ],
                  },
                ],
              }
            : {
                errors: [{ error: 'Неверное значение поля sum: сумма позиции превышает лимит', code: 3002 }],
              },
        ),
      );
    }
    const detail =
      outcome === 'dead'
        ? accounting === 'xero'
          ? 'The document total exceeds the limit allowed for this demo organisation'
          : 'Неверное значение поля sum: сумма позиции превышает лимит (3002)'
        : null;
    events.push({
      level: outcome === 'dead' ? 'error' : 'warn',
      message:
        outcome === 'dead'
          ? `${accounting} rejected the request: ${detail}`
          : 'On hold: waiting for a product mapping, resolved later',
      offsetMs: failAt,
    });
    return [
      {
        op: {
          id: opId(),
          integrationId: plan.integrationId,
          type: 'order.export',
          // blocked orders from the past were resolved and went through; dead ones are still waiting
          status: outcome === 'dead' ? 'dead' : 'succeeded',
          subject: `Order #${orderId}`,
          subjectRef: String(orderId),
          dedupeKey: `order.export:${plan.integrationId}:hist-${orderId}`,
          attempts: outcome === 'dead' ? 1 : 2,
          waitedMs: Math.round(waitedMs),
          durationMs: Math.round(docMs + fetchMs),
          errorCode: outcome === 'dead' ? 'validation_rejected' : null,
          errorParams: outcome === 'dead' ? { provider: accounting } : Prisma.DbNull,
          errorDetail: detail,
          payload: {},
          result:
            outcome === 'dead'
              ? Prisma.DbNull
              : {
                  documentId: docId,
                  number: docNumber,
                  url: docUrl,
                  totalMinor: total,
                  currency: plan.currency,
                },
          startedAt: new Date(created.getTime() + queueMs),
          finishedAt: new Date(
            created.getTime() + (outcome === 'dead' ? failAt : failAt + waitedMs + between(900, 2400)),
          ),
          createdAt: created,
          updatedAt: new Date(created.getTime() + failAt),
        },
        events,
        exchanges,
      },
    ];
  }

  const docAt = queueMs + fetchMs + retryDelay;
  exchanges.push(
    exchange(
      plan.accountingConnectionId,
      'GET',
      `${acc}/${accounting === 'moysklad' ? `entity/counterparty?filter=externalCode%3D${plan.prefix}-c${customer.lastName.length}` : 'Contacts'}`,
      200,
      between(90, 260),
      docAt,
      null,
      accounting === 'moysklad'
        ? {
            meta: { size: 1 },
            rows: [{ id: `cp-${customer.lastName}`, name: `${customer.firstName} ${customer.lastName}` }],
          }
        : {
            Contacts: [
              { ContactID: `c-${customer.lastName}`, Name: `${customer.firstName} ${customer.lastName}` },
            ],
          },
    ),
    exchange(
      plan.accountingConnectionId,
      accounting === 'xero' ? 'PUT' : 'POST',
      `${acc}/${accounting === 'xero' ? 'Invoices' : 'entity/customerorder'}`,
      200,
      docMs,
      docAt + 300,
      {
        name: docNumber,
        externalCode: `${plan.prefix}-${orderId}`,
        positions: lines.map((l) => ({
          article: l.product.sku,
          quantity: l.quantity,
          price: l.product.priceMinor,
        })),
      },
      { id: docId, name: docNumber, sum: total, attempt: outcome === 'retried' ? 2 : 1 },
      outcome === 'retried' ? 2 : 1,
    ),
  );
  events.push({ level: 'info', message: `Created ${docNumber} in ${accounting}`, offsetMs: totalMs - 50 });
  events.push({ level: 'info', message: 'Done', offsetMs: totalMs });

  const order: HistoryOp = {
    op: {
      id: opId(),
      integrationId: plan.integrationId,
      type: 'order.export',
      status: 'succeeded',
      subject: `Order #${orderId}`,
      subjectRef: String(orderId),
      dedupeKey: `order.export:${plan.integrationId}:hist-${orderId}`,
      attempts: outcome === 'retried' ? 2 : 1,
      durationMs: Math.round(fetchMs + docMs + 200),
      payload: {},
      result: {
        documentId: docId,
        number: docNumber,
        url: docUrl,
        lines: lines.length,
        totalMinor: total,
        currency: plan.currency,
      },
      startedAt: new Date(created.getTime() + queueMs),
      finishedAt: new Date(created.getTime() + totalMs),
      createdAt: created,
      updatedAt: new Date(created.getTime() + totalMs),
    },
    events,
    exchanges,
  };

  if (rand() > 0.88) return [order];
  const paidAt = new Date(created.getTime() + totalMs + between(800, rand() < 0.75 ? 4000 : 3_600_000));
  const payMs = between(300, 1400);
  const payment: HistoryOp = {
    op: {
      id: opId(),
      integrationId: plan.integrationId,
      type: 'payment.export',
      status: 'succeeded',
      subject: `Payment for #${orderId}`,
      subjectRef: String(orderId),
      dedupeKey: `payment.export:${plan.integrationId}:hist-${orderId}`,
      attempts: 1,
      durationMs: Math.round(payMs),
      payload: {},
      result: { paymentId: `pay-${orderId}`, url: docUrl, amountMinor: total, currency: plan.currency },
      startedAt: paidAt,
      finishedAt: new Date(paidAt.getTime() + payMs),
      createdAt: paidAt,
      updatedAt: new Date(paidAt.getTime() + payMs),
    },
    events: [
      {
        level: 'info',
        message: `Payment ${money(total, plan.currency)} linked to the order document`,
        offsetMs: payMs - 20,
      },
      { level: 'info', message: 'Done', offsetMs: payMs },
    ],
    exchanges: [
      exchange(
        plan.accountingConnectionId,
        accounting === 'xero' ? 'PUT' : 'POST',
        `${acc}/${accounting === 'xero' ? 'Payments' : 'entity/paymentin'}`,
        200,
        payMs * 0.7,
        120,
        { sum: total, operations: [{ linkedSum: total }] },
        { id: `pay-${orderId}`, sum: total },
      ),
    ],
  };
  return [order, payment];
}

function maintenanceHistory(plan: ShopPlan, at: Date, type: 'stock.push' | 'orders.reconcile'): HistoryOp {
  const ms = between(400, 2400);
  const changed = type === 'stock.push' ? Math.floor(rand() * rand() * 7) : 0;
  const missed = type === 'orders.reconcile' && rand() < 0.04 ? 1 : 0;
  return {
    op: {
      id: opId(),
      integrationId: plan.integrationId,
      type,
      status: 'succeeded',
      subject: type === 'stock.push' ? 'Stock levels to store' : 'Order reconciliation',
      dedupeKey: `${type}:${plan.integrationId}:hist-${at.getTime()}`,
      attempts: 1,
      durationMs: Math.round(ms),
      payload: {},
      result:
        type === 'stock.push'
          ? { checked: plan.products.length, changed, updated: changed }
          : { scanned: Math.floor(between(2, 14)), queued: missed },
      startedAt: at,
      finishedAt: new Date(at.getTime() + ms),
      createdAt: at,
      updatedAt: new Date(at.getTime() + ms),
    },
    events: [
      missed
        ? { level: 'warn', message: 'Found 1 orders that webhooks missed, queued them', offsetMs: ms - 30 }
        : {
            level: 'info',
            message:
              type === 'stock.push' ? `Stock updated for ${changed} of ${changed} changed items` : 'Done',
            offsetMs: ms,
          },
    ],
    exchanges: [],
  };
}

async function history(): Promise<void> {
  const ops: HistoryOp[] = [];
  const now = Date.now();
  // history stops an hour ago; the live generator fills in from there
  const end = now - 60 * 60_000;
  const start = end - HISTORY_DAYS * 86_400_000;

  for (const plan of [ZERNO, HILLSIDE]) {
    let orderId = plan.firstOrderId;
    for (let day = 0; day < HISTORY_DAYS; day++) {
      const dayStart = start + day * 86_400_000;
      const weekday = new Date(dayStart).getUTCDay();
      const weekendBoost = weekday === 0 || weekday === 6 ? 1.25 : 1;
      const growth = 0.8 + (day / HISTORY_DAYS) * 0.4;
      const count = Math.round(between(...plan.ordersPerDay) * weekendBoost * growth);
      for (let i = 0; i < count; i++) {
        // orders cluster in daytime hours
        const hour = 7 + rand() * 15 + (rand() - 0.5) * 3;
        const created = new Date(dayStart + hour * 3_600_000);
        if (created.getTime() > end) continue;
        ops.push(...orderHistory(plan, orderId++, created));
      }
      for (let hour = 0; hour < 24; hour += 1) {
        const at = new Date(dayStart + hour * 3_600_000 + between(0, 60_000));
        if (at.getTime() > end) continue;
        ops.push(maintenanceHistory(plan, at, hour % 2 === 0 ? 'stock.push' : 'orders.reconcile'));
      }
    }
  }

  for (let i = 0; i < ops.length; i += 500) {
    const chunk = ops.slice(i, i + 500);
    await prisma.operation.createMany({ data: chunk.map((h) => h.op) });
    await prisma.operationEvent.createMany({
      data: chunk.flatMap((h) =>
        h.events.map((e) => ({
          operationId: h.op.id as string,
          level: e.level,
          message: e.message,
          at: new Date((h.op.createdAt as Date).getTime() + e.offsetMs),
        })),
      ),
    });
    await prisma.httpExchange.createMany({
      data: chunk.flatMap((h) =>
        h.exchanges.map(({ offsetMs, ...x }) => ({
          ...x,
          operationId: h.op.id as string,
          createdAt: new Date((h.op.createdAt as Date).getTime() + offsetMs),
        })),
      ),
    });
  }
  console.log(`History: ${ops.length} operations over ${HISTORY_DAYS} days`);

  await prisma.alert.createMany({
    data: [
      {
        workspaceId: DEMO_IDS.workspace,
        channel: 'log',
        severity: 'warning',
        title: 'Зерно и Пар: needs a mapping',
        body: 'sku_not_mapped: ZP-MUG-ENAMEL. Orders with it are on hold until it is linked on the Conflicts page.',
        dedupeKey: 'hist:conflict',
        createdAt: new Date(end - 6 * 86_400_000),
      },
      {
        workspaceId: DEMO_IDS.workspace,
        channel: 'log',
        severity: 'critical',
        title: 'Hillside Tea Co.: Order failed',
        body: 'xero rejected the request. It is in failed jobs with the full request and response, ready to retry.',
        dedupeKey: 'hist:dead',
        createdAt: new Date(end - 2 * 86_400_000),
      },
    ],
  });
}

async function main(): Promise<void> {
  await reset();
  await workspace();
  await connections();
  await history();
  console.log('Demo workspace ready');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
