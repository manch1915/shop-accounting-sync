import { SANDBOX_PATHS } from '@sas/demo-data';
import { type Context, Hono } from 'hono';
import { type FaultSettings, faultInjection, RequestWindow } from '../faults.js';
import { MOYSKLAD, newMsId } from '../ids.js';
import type { Random } from '../random.js';
import { msMoment, parseMsMoment } from '../state/clock.js';
import {
  type MoySkladAccount,
  type MsCounterpartyRec,
  type MsOrderRec,
  type MsPaymentRec,
  type MsPositionRec,
  type MsProductRec,
  orderTotals,
} from '../state/moysklad.js';
import type { SandboxState } from '../state/sandbox.js';

type Json = Record<string, unknown>;
type MsStatus = 400 | 401 | 404 | 412 | 429;

const MAX_LIMIT = 1000;
// МойСклад allows 45 requests per 3 seconds per account
const RATE_LIMIT = 45;
const RATE_WINDOW_MS = 3_000;
const VAT_RATES = new Set([0, 5, 7, 10, 20, 22]);
const MORE_INFO = 'https://dev.moysklad.ru/doc/api/remap/1.2/#error_';

function msError(c: Context, status: MsStatus, errors: Array<{ error: string; code: number }>) {
  return c.json({ errors: errors.map((e) => ({ ...e, moreInfo: `${MORE_INFO}${e.code}` })) }, status);
}

export function moySkladApp(state: SandboxState, token: string, faults: FaultSettings, random: Random): Hono {
  const app = new Hono();
  const ms = state.moysklad;
  const window = new RequestWindow(RATE_LIMIT, RATE_WINDOW_MS);

  app.use('*', async (c, next) => {
    if (c.req.header('authorization') !== `Bearer ${token}`) {
      return msError(c, 401, [
        {
          error: 'Ошибка аутентификации: Неправильный пароль или имя пользователя или ключ авторизации',
          code: 1056,
        },
      ]);
    }
    // the real API refuses uncompressed responses
    if (!(c.req.header('accept-encoding') ?? '').includes('gzip')) return c.body(null, 415);
    const usage = window.hit();
    c.header('X-RateLimit-Limit', String(RATE_LIMIT));
    c.header('X-RateLimit-Remaining', String(usage.remaining));
    c.header('X-Lognex-Retry-TimeInterval', String(RATE_WINDOW_MS));
    if (!usage.allowed) return rateLimited(c, usage.retryAfterMs);
    await next();
  });

  app.use(
    '*',
    faultInjection(
      faults,
      {
        rateLimited: (c) => rateLimited(c, random.int(1500, 4000)),
        unavailable: (c) =>
          c.html(
            '<html><head><title>503 Service Temporarily Unavailable</title></head><body><center><h1>503 Service Temporarily Unavailable</h1></center><hr><center>nginx</center></body></html>',
            503,
          ),
      },
      random,
    ),
  );

  app.get('/entity/organization', (c) =>
    list(
      c,
      'organization',
      [ms.organization].map((o) => named(c, 'organization', o)),
    ),
  );
  app.get('/entity/store', (c) =>
    list(
      c,
      'store',
      ms.stores.map((s) => named(c, 'store', s)),
    ),
  );
  app.get('/entity/taxrate', (c) =>
    list(
      c,
      'taxrate',
      ms.taxRates.map((t) => ({
        meta: meta(c, 'taxrate', t.id),
        id: t.id,
        rate: t.rate,
        comment: t.comment,
        archived: false,
      })),
    ),
  );

  app.get('/entity/product', (c) =>
    list(
      c,
      'product',
      [...ms.products.values()].map((p) => productJson(c, p)),
    ),
  );
  app.get('/entity/product/:id', (c) => {
    const product = ms.products.get(c.req.param('id'));
    return product ? c.json(productJson(c, product)) : notFound(c, 'product', c.req.param('id'));
  });

  app.get('/entity/service', (c) =>
    list(
      c,
      'service',
      [...ms.services.values()].map((s) => ({
        ...named(c, 'service', s),
        code: s.code,
        archived: false,
        updated: msMoment(s.updated),
      })),
    ),
  );
  app.post('/entity/service', async (c) => {
    const body = await readJson(c);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) return emptyField(c, 'name');
    const service = { id: newMsId(), name, code: ms.nextCode(), updated: new Date() };
    ms.services.set(service.id, service);
    return c.json({
      ...named(c, 'service', service),
      code: service.code,
      archived: false,
      updated: msMoment(service.updated),
    });
  });

  app.get('/entity/counterparty', (c) =>
    list(
      c,
      'counterparty',
      [...ms.counterparties.values()].map((cp) => counterpartyJson(c, cp)),
    ),
  );
  app.get('/entity/counterparty/:id', (c) => {
    const cp = ms.counterparties.get(c.req.param('id'));
    return cp ? c.json(counterpartyJson(c, cp)) : notFound(c, 'counterparty', c.req.param('id'));
  });
  app.post('/entity/counterparty', async (c) => {
    const body = await readJson(c);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!body || !name) return emptyField(c, 'name');
    const cp: MsCounterpartyRec = {
      id: newMsId(),
      name,
      externalCode: typeof body.externalCode === 'string' ? body.externalCode : newMsId().slice(0, 18),
      email: str(body.email),
      phone: str(body.phone),
      actualAddress: str(body.actualAddress),
      companyType:
        body.companyType === 'legal' || body.companyType === 'entrepreneur' ? body.companyType : 'individual',
      created: new Date(),
    };
    ms.counterparties.set(cp.id, cp);
    return c.json(counterpartyJson(c, cp));
  });

  app.get('/entity/customerorder/metadata', (c) =>
    c.json({
      meta: { href: `${base(c)}/entity/customerorder/metadata`, mediaType: 'application/json' },
      attributes: [],
      states: ms.states.map((s) => ({
        meta: meta(c, 'state', s.id, 'customerorder/metadata/states'),
        id: s.id,
        accountId: MOYSKLAD.accountId,
        name: s.name,
        color: s.color,
        stateType: s.stateType,
        entityType: 'customerorder',
      })),
      createShared: false,
    }),
  );
  app.get('/entity/customerorder', (c) =>
    list(
      c,
      'customerorder',
      [...ms.orders.values()].map((o) => orderJson(c, o)),
    ),
  );
  app.get('/entity/customerorder/:id', (c) => {
    const order = ms.orders.get(c.req.param('id'));
    return order ? c.json(orderJson(c, order)) : notFound(c, 'customerorder', c.req.param('id'));
  });
  app.post('/entity/customerorder', async (c) => {
    const body = await readJson(c);
    if (!body) return badJson(c);
    const problem =
      checkRef(ms, body.organization, 'organization', true) ?? checkRef(ms, body.agent, 'counterparty', true);
    if (problem) return msError(c, 412, [problem]);
    for (const [ref, type] of [
      [body.store, 'store'],
      [body.state, 'state'],
    ] as const) {
      const issue = checkRef(ms, ref, type, false);
      if (issue) return msError(c, 412, [issue]);
    }
    const positions: MsPositionRec[] = [];
    for (const raw of Array.isArray(body.positions) ? (body.positions as Json[]) : []) {
      const parsed = parsePosition(ms, raw);
      if ('error' in parsed) return msError(c, 412, [parsed]);
      positions.push(parsed);
    }
    const moment = typeof body.moment === 'string' ? parseMsMoment(body.moment) : new Date();
    if (!moment)
      return msError(c, 400, [
        { error: "Ошибка формата: значение поля 'moment' не соответствует типу", code: 2016 },
      ]);
    const vatEnabled = body.vatEnabled !== false;
    const vatIncluded = body.vatIncluded !== false;
    const now = new Date();
    const order: MsOrderRec = {
      id: newMsId(),
      name: typeof body.name === 'string' && body.name ? body.name : ms.nextOrderName(),
      externalCode: typeof body.externalCode === 'string' ? body.externalCode : newMsId().slice(0, 18),
      moment,
      created: now,
      updated: now,
      agentId: refId(body.agent) ?? '',
      storeId: refId(body.store),
      stateId: refId(body.state) ?? ms.states[0]?.id ?? null,
      description: str(body.description),
      vatEnabled,
      vatIncluded,
      positions,
      ...orderTotals(positions, vatEnabled, vatIncluded),
      payedSum: 0,
    };
    ms.orders.set(order.id, order);
    return c.json(orderJson(c, order));
  });

  app.get('/entity/paymentin', (c) =>
    list(
      c,
      'paymentin',
      [...ms.payments.values()].map((p) => paymentJson(c, p)),
    ),
  );
  app.post('/entity/paymentin', async (c) => {
    const body = await readJson(c);
    if (!body) return badJson(c);
    const problem =
      checkRef(ms, body.organization, 'organization', true) ?? checkRef(ms, body.agent, 'counterparty', true);
    if (problem) return msError(c, 412, [problem]);
    const sum = Number(body.sum ?? 0);
    if (!Number.isFinite(sum) || sum < 0) {
      return msError(c, 400, [
        { error: "Ошибка формата: значение поля 'sum' не соответствует типу", code: 2016 },
      ]);
    }
    const operations: MsPaymentRec['operations'] = [];
    for (const op of Array.isArray(body.operations) ? (body.operations as Json[]) : []) {
      const issue = checkRef(ms, op, 'customerorder', true);
      if (issue) return msError(c, 412, [issue]);
      operations.push({ orderId: refId(op) ?? '', linkedSum: Number(op.linkedSum ?? sum) });
    }
    const now = new Date();
    const payment: MsPaymentRec = {
      id: newMsId(),
      name: typeof body.name === 'string' && body.name ? body.name : ms.nextPaymentName(),
      moment: (typeof body.moment === 'string' ? parseMsMoment(body.moment) : null) ?? now,
      created: now,
      agentId: refId(body.agent) ?? '',
      sum,
      paymentPurpose: str(body.paymentPurpose) ?? '',
      operations,
    };
    for (const op of operations) {
      const order = ms.orders.get(op.orderId);
      if (order) {
        order.payedSum += op.linkedSum;
        order.updated = now;
      }
    }
    ms.payments.set(payment.id, payment);
    return c.json(paymentJson(c, payment));
  });

  app.get('/report/stock/all/current', (c) => stockReport(c, ms, false));
  app.get('/report/stock/bystore/current', (c) => stockReport(c, ms, true));

  app.all('*', (c) =>
    msError(c, 404, [
      { error: `Неизвестный тип: '${c.req.path.replace(/^.*\/remap\/1\.2\//, '')}'`, code: 1005 },
    ]),
  );
  return app;
}

function rateLimited(c: Context, retryAfterMs: number) {
  c.header('X-Lognex-Retry-After', String(Math.max(1, Math.round(retryAfterMs))));
  c.header('X-RateLimit-Remaining', '0');
  return msError(c, 429, [
    { error: 'Превышено ограничение на количество запросов в единицу времени', code: 1049 },
  ]);
}

function base(c: Context): string {
  return `${new URL(c.req.url).origin}${SANDBOX_PATHS.moysklad}`;
}

function meta(c: Context, type: string, id: string, path: string = type) {
  return {
    href: `${base(c)}/entity/${path}/${id}`,
    metadataHref: `${base(c)}/entity/${path.split('/')[0]}/metadata`,
    type,
    mediaType: 'application/json',
    uuidHref: `https://online.moysklad.ru/app/#${type}/edit?id=${id}`,
  };
}

function named(c: Context, type: string, entity: { id: string; name: string }) {
  return { meta: meta(c, type, entity.id), id: entity.id, accountId: MOYSKLAD.accountId, name: entity.name };
}

function list(c: Context, type: string, all: Json[]) {
  const filters = parseFilter(c.req.query('filter'));
  const search = c.req.query('search')?.toLowerCase();
  const rows = all
    .filter((row) => filters.every(([field, op, value]) => matches(row[field], op, value)))
    .filter(
      (row) =>
        !search ||
        String(row.name ?? '')
          .toLowerCase()
          .includes(search),
    );
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(c.req.query('limit') ?? MAX_LIMIT) || MAX_LIMIT));
  const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0);
  return c.json({
    context: { employee: { meta: { type: 'employee', href: `${base(c)}/context/employee` } } },
    meta: {
      href: `${base(c)}/entity/${type}`,
      type,
      mediaType: 'application/json',
      size: rows.length,
      limit,
      offset,
    },
    rows: rows.slice(offset, offset + limit),
  });
}

// filter=externalCode=woo-c87;name~Кофе
function parseFilter(raw: string | undefined): Array<[string, '=' | '!=' | '~', string]> {
  if (!raw) return [];
  const out: Array<[string, '=' | '!=' | '~', string]> = [];
  for (const part of raw.split(';')) {
    const match = /^(\w+)(!=|=|~)(.*)$/.exec(part);
    if (match) out.push([match[1] ?? '', match[2] as '=' | '!=' | '~', match[3] ?? '']);
  }
  return out;
}

function matches(actual: unknown, op: '=' | '!=' | '~', expected: string): boolean {
  const text = actual === undefined || actual === null ? '' : String(actual);
  if (op === '~') return text.toLowerCase().includes(expected.toLowerCase());
  return op === '=' ? text === expected : text !== expected;
}

function productJson(c: Context, p: MsProductRec) {
  return {
    meta: meta(c, 'product', p.id),
    id: p.id,
    accountId: MOYSKLAD.accountId,
    shared: true,
    updated: msMoment(p.updated),
    name: p.name,
    code: p.code,
    externalCode: p.externalCode,
    archived: p.archived,
    pathName: '',
    useParentVat: false,
    vat: p.vat ?? 0,
    vatEnabled: p.vat !== null,
    effectiveVat: p.vat ?? 0,
    effectiveVatEnabled: p.vat !== null,
    article: p.article,
    barcodes: p.barcodes.map((b) =>
      b.length === 13 ? { ean13: b } : b.length === 8 ? { ean8: b } : { code128: b },
    ),
    salePrices: [
      {
        value: p.priceMinor,
        currency: { meta: meta(c, 'currency', MOYSKLAD.currencyId) },
        priceType: {
          meta: meta(c, 'pricetype', MOYSKLAD.priceTypeId, 'context/companysettings/pricetype'),
          id: MOYSKLAD.priceTypeId,
          name: 'Цена продажи',
          externalCode: 'cbcf493b-55bc-11d9-848a-00112f43529a',
        },
      },
    ],
    paymentItemType: p.tracked ? 'GOOD' : 'SERVICE',
    trackingType: 'NOT_TRACKED',
    variantsCount: 0,
    isSerialTrackable: false,
  };
}

function counterpartyJson(c: Context, cp: MsCounterpartyRec) {
  return {
    ...named(c, 'counterparty', cp),
    shared: true,
    updated: msMoment(cp.created),
    created: msMoment(cp.created),
    externalCode: cp.externalCode,
    archived: false,
    companyType: cp.companyType,
    ...(cp.email ? { email: cp.email } : {}),
    ...(cp.phone ? { phone: cp.phone } : {}),
    ...(cp.actualAddress ? { actualAddress: cp.actualAddress } : {}),
    tags: ['интернет-магазин'],
    salesAmount: 0,
  };
}

function orderJson(c: Context, o: MsOrderRec) {
  return {
    meta: meta(c, 'customerorder', o.id),
    id: o.id,
    accountId: MOYSKLAD.accountId,
    updated: msMoment(o.updated),
    created: msMoment(o.created),
    name: o.name,
    externalCode: o.externalCode,
    moment: msMoment(o.moment),
    applicable: true,
    ...(o.description ? { description: o.description } : {}),
    rate: { currency: { meta: meta(c, 'currency', MOYSKLAD.currencyId) } },
    sum: o.sum,
    vatEnabled: o.vatEnabled,
    vatIncluded: o.vatIncluded,
    vatSum: o.vatSum,
    payedSum: o.payedSum,
    shippedSum: 0,
    invoicedSum: 0,
    reservedSum: 0,
    organization: { meta: meta(c, 'organization', MOYSKLAD.organizationId) },
    agent: { meta: meta(c, 'counterparty', o.agentId) },
    ...(o.storeId ? { store: { meta: meta(c, 'store', o.storeId) } } : {}),
    ...(o.stateId ? { state: { meta: meta(c, 'state', o.stateId, 'customerorder/metadata/states') } } : {}),
    positions: {
      meta: {
        href: `${base(c)}/entity/customerorder/${o.id}/positions`,
        type: 'customerorderposition',
        mediaType: 'application/json',
        size: o.positions.length,
        limit: 1000,
        offset: 0,
      },
    },
  };
}

function paymentJson(c: Context, p: MsPaymentRec) {
  return {
    meta: meta(c, 'paymentin', p.id),
    id: p.id,
    accountId: MOYSKLAD.accountId,
    updated: msMoment(p.created),
    created: msMoment(p.created),
    name: p.name,
    moment: msMoment(p.moment),
    applicable: true,
    sum: p.sum,
    paymentPurpose: p.paymentPurpose,
    organization: { meta: meta(c, 'organization', MOYSKLAD.organizationId) },
    agent: { meta: meta(c, 'counterparty', p.agentId) },
    operations: p.operations.map((op) => ({
      meta: meta(c, 'customerorder', op.orderId),
      linkedSum: op.linkedSum,
    })),
  };
}

function stockReport(c: Context, ms: MoySkladAccount, byStore: boolean) {
  const stockType = c.req.query('stockType') ?? 'stock';
  if (!['stock', 'freeStock', 'quantity'].includes(stockType)) {
    return msError(c, 412, [
      { error: `Неизвестное значение параметра 'stockType': ${stockType}`, code: 1001 },
    ]);
  }
  const withZero = c.req.query('include') === 'zeroLines';
  const filters = parseFilter(c.req.query('filter'));
  const storeFilter = filters.find(([field]) => field === 'storeId')?.[2];
  const productFilter = new Set(filters.filter(([field]) => field === 'assortmentId').map(([, , v]) => v));
  const changedSince = c.req.query('changedSince');
  const since = changedSince ? parseMsMoment(changedSince) : null;

  const rows: Json[] = [];
  for (const product of ms.products.values()) {
    // certificates never pass through a warehouse, so the report has no row for them
    if (!product.tracked || product.archived) continue;
    if (productFilter.size && !productFilter.has(product.id)) continue;
    if (since && product.stockChangedAt < since) continue;
    if (byStore) {
      for (const [storeId, qty] of product.stock) {
        if (storeFilter && storeId !== storeFilter) continue;
        if (qty === 0 && !withZero) continue;
        rows.push({ assortmentId: product.id, storeId, [stockType]: qty });
      }
    } else {
      const qty = ms.totalStock(product);
      if (qty === 0 && !withZero && !since) continue;
      rows.push({ assortmentId: product.id, [stockType]: qty });
    }
  }
  return c.json(rows);
}

function parsePosition(ms: MoySkladAccount, raw: Json): MsPositionRec | { error: string; code: number } {
  const ref = raw.assortment as Json | undefined;
  const type = ((ref?.meta as Json | undefined)?.type as string | undefined) ?? '';
  const id = refId(ref);
  if (!id || (type !== 'product' && type !== 'service')) {
    return { error: "Ошибка сохранения объекта: поле 'assortment' не может быть пустым", code: 3000 };
  }
  if (!ms.hasAssortment(type, id))
    return { error: `Объект с идентификатором '${id}' и типом '${type}' не найден`, code: 1021 };
  const quantity = Number(raw.quantity);
  const price = Number(raw.price ?? 0);
  const discount = Number(raw.discount ?? 0);
  const vat = Number(raw.vat ?? 0);
  if (!(quantity > 0) || !(price >= 0) || !(discount >= 0 && discount <= 100)) {
    return { error: "Ошибка формата: значение поля 'positions' не соответствует типу", code: 2016 };
  }
  if (!VAT_RATES.has(vat)) return { error: `Недопустимое значение ставки НДС: ${vat}`, code: 3018 };
  return {
    id: newMsId(),
    quantity,
    price,
    discount,
    vat,
    vatEnabled: raw.vatEnabled === undefined ? vat > 0 : raw.vatEnabled === true,
    assortment: { type, id },
  };
}

function checkRef(ms: MoySkladAccount, ref: unknown, type: string, required: boolean) {
  const id = refId(ref);
  if (!id) {
    return required
      ? { error: `Ошибка сохранения объекта: поле '${fieldName(type)}' не может быть пустым`, code: 3000 }
      : null;
  }
  const exists =
    type === 'organization'
      ? id === ms.organization.id
      : type === 'counterparty'
        ? ms.counterparties.has(id)
        : type === 'store'
          ? ms.stores.some((s) => s.id === id)
          : type === 'state'
            ? ms.states.some((s) => s.id === id)
            : type === 'customerorder' && ms.orders.has(id);
  return exists
    ? null
    : { error: `Объект с идентификатором '${id}' и типом '${type}' не найден`, code: 1021 };
}

function fieldName(type: string): string {
  return type === 'counterparty' ? 'agent' : type;
}

function refId(ref: unknown): string | null {
  const href = ((ref as Json | undefined)?.meta as Json | undefined)?.href;
  if (typeof href !== 'string') return null;
  return href.split('?')[0]?.split('/').filter(Boolean).pop() ?? null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function notFound(c: Context, type: string, id: string) {
  return msError(c, 404, [
    { error: `Объект с идентификатором '${id}' и типом '${type}' не найден`, code: 1021 },
  ]);
}

function emptyField(c: Context, field: string) {
  return msError(c, 412, [
    { error: `Ошибка сохранения объекта: поле '${field}' не может быть пустым`, code: 3000 },
  ]);
}

function badJson(c: Context) {
  return msError(c, 400, [{ error: 'Ошибка формата JSON в запросе', code: 2014 }]);
}

async function readJson(c: Context): Promise<Json | null> {
  try {
    const body: unknown = await c.req.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Json) : null;
  } catch {
    return null;
  }
}
