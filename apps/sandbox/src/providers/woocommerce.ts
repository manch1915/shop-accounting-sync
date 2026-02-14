import { type Context, Hono } from 'hono';
import { WOOCOMMERCE } from '../ids.js';
import type { SandboxState } from '../state/sandbox.js';
import type { ProductPatch, WooOrder } from '../state/woocommerce.js';

const BATCH_LIMIT = 100;
const MAX_PER_PAGE = 100;

type WcErrorStatus = 400 | 401 | 404 | 413;

function wcError(c: Context, status: WcErrorStatus, code: string, message: string, extra: object = {}) {
  return c.json({ code, message, data: { status, ...extra } }, status);
}

export function wooCommerceApp(state: SandboxState, token: string): Hono {
  const app = new Hono();
  const woo = state.woo;

  app.use('*', async (c, next) => {
    const { key, secret } = readCredentials(c);
    const verb = c.req.method === 'GET' ? 'list' : c.req.method === 'POST' ? 'create' : 'edit';
    if (!key) {
      return wcError(c, 401, 'woocommerce_rest_cannot_view', `Sorry, you cannot ${verb} resources.`);
    }
    if (key !== WOOCOMMERCE.consumerKey) {
      return wcError(c, 401, 'woocommerce_rest_authentication_error', 'Consumer key is invalid.');
    }
    if (secret !== token) {
      return wcError(c, 401, 'woocommerce_rest_authentication_error', 'Consumer secret is invalid.');
    }
    await next();
  });

  app.get('/products', (c) => {
    const status = c.req.query('status') ?? 'any';
    const sku = c.req.query('sku');
    const rows = [...woo.products.values()]
      .filter((p) => status === 'any' || p.status === status)
      .filter((p) => !sku || p.sku === sku)
      .sort((a, b) => b.id - a.id)
      .map((p) => woo.productJson(p));
    return paginate(c, rows);
  });

  app.post('/products', async (c) => {
    const body = await readJson(c);
    if (!body) return wcError(c, 400, 'rest_invalid_json', 'Invalid JSON body passed.');
    const result = woo.createProduct(body, new Date());
    if ('code' in result) return wcError(c, 400, result.code, result.message);
    return c.json(woo.productJson(result), 201);
  });

  app.post('/products/batch', async (c) => {
    const body = await readJson(c);
    if (!body) return wcError(c, 400, 'rest_invalid_json', 'Invalid JSON body passed.');
    const create = arrayOf(body.create);
    const update = arrayOf(body.update);
    const remove = arrayOf(body.delete);
    if (create.length + update.length + remove.length > BATCH_LIMIT) {
      return tooMany(c);
    }
    const now = new Date();
    return c.json({
      create: create.map((item) => {
        const result = woo.createProduct(item, now);
        return 'code' in result ? itemError(0, result) : woo.productJson(result);
      }),
      update: update.map((item) => {
        const id = Number(item.id);
        const error = woo.updateProduct(id, item, now);
        const product = woo.products.get(id);
        return error || !product ? itemError(id, error) : woo.productJson(product);
      }),
      delete: remove.map((value) => {
        const id = Number(value);
        const product = woo.products.get(id);
        if (!product) return itemError(id, null);
        woo.products.delete(id);
        return woo.productJson(product);
      }),
    });
  });

  app.get('/products/:id', (c) => {
    const product = woo.products.get(Number(c.req.param('id')));
    if (!product) return wcError(c, 404, 'woocommerce_rest_product_invalid_id', 'Invalid ID.');
    return c.json(woo.productJson(product));
  });

  app.put('/products/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const body = await readJson(c);
    if (!body) return wcError(c, 400, 'rest_invalid_json', 'Invalid JSON body passed.');
    const error = woo.updateProduct(id, body, new Date());
    const product = woo.products.get(id);
    if (!product) return wcError(c, 404, 'woocommerce_rest_product_invalid_id', 'Invalid ID.');
    if (error) return wcError(c, 400, error.code, error.message);
    return c.json(woo.productJson(product));
  });

  app.get('/products/:id/variations', (c) => {
    const product = woo.products.get(Number(c.req.param('id')));
    if (!product) return wcError(c, 404, 'woocommerce_rest_product_invalid_id', 'Invalid ID.');
    return paginate(
      c,
      product.variations.map((v) => woo.variationJson(product, v)),
    );
  });

  app.post('/products/:id/variations/batch', async (c) => {
    const productId = Number(c.req.param('id'));
    const product = woo.products.get(productId);
    if (!product) return wcError(c, 404, 'woocommerce_rest_product_invalid_id', 'Invalid ID.');
    const body = await readJson(c);
    if (!body) return wcError(c, 400, 'rest_invalid_json', 'Invalid JSON body passed.');
    const update = arrayOf(body.update);
    if (update.length > BATCH_LIMIT) return tooMany(c);
    const now = new Date();
    return c.json({
      update: update.map((item) => {
        const id = Number(item.id);
        const error = woo.updateVariation(productId, id, item, now);
        const variation = woo.findVariation(productId, id);
        return error || !variation ? itemError(id, error) : woo.variationJson(product, variation);
      }),
    });
  });

  app.get('/products/:id/variations/:variationId', (c) => {
    const product = woo.products.get(Number(c.req.param('id')));
    const variation = woo.findVariation(Number(c.req.param('id')), Number(c.req.param('variationId')));
    if (!product || !variation) {
      return wcError(c, 404, 'woocommerce_rest_product_variation_invalid_id', 'Invalid ID.');
    }
    return c.json(woo.variationJson(product, variation));
  });

  app.get('/orders', (c) => {
    const q = c.req.query();
    const gmt = q.dates_are_gmt === 'true' || q.dates_are_gmt === '1';
    const bounds = {
      modifiedAfter: parseWpDate(q.modified_after, gmt),
      modifiedBefore: parseWpDate(q.modified_before, gmt),
      after: parseWpDate(q.after, gmt),
      before: parseWpDate(q.before, gmt),
    };
    const statuses = q.status && q.status !== 'any' ? new Set(q.status.split(',')) : null;
    const orderby = q.orderby ?? 'date';
    const direction = q.order === 'asc' ? 1 : -1;
    const time = (o: WooOrder, field: 'date_created_gmt' | 'date_modified_gmt') =>
      Date.parse(`${o.json[field]}Z`);

    const rows = [...woo.orders.values()]
      .filter((o) => !statuses || statuses.has(o.json.status))
      .filter((o) => !bounds.modifiedAfter || time(o, 'date_modified_gmt') > bounds.modifiedAfter)
      .filter((o) => !bounds.modifiedBefore || time(o, 'date_modified_gmt') < bounds.modifiedBefore)
      .filter((o) => !bounds.after || time(o, 'date_created_gmt') > bounds.after)
      .filter((o) => !bounds.before || time(o, 'date_created_gmt') < bounds.before)
      .sort((a, b) => {
        if (orderby === 'id') return (a.id - b.id) * direction;
        const field = orderby === 'modified' ? 'date_modified_gmt' : 'date_created_gmt';
        return (time(a, field) - time(b, field) || a.id - b.id) * direction;
      })
      .map((o) => o.json);
    return paginate(c, rows);
  });

  app.get('/orders/:id', (c) => {
    const order = woo.orders.get(Number(c.req.param('id')));
    if (!order) return wcError(c, 404, 'woocommerce_rest_shop_order_invalid_id', 'Invalid ID.');
    return c.json(order.json);
  });

  app.all('*', (c) =>
    wcError(c, 404, 'rest_no_route', 'No route was found matching the URL and request method.'),
  );

  return app;
}

function readCredentials(c: Context): { key: string | null; secret: string | null } {
  const header = c.req.header('authorization');
  if (header?.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const split = decoded.indexOf(':');
    return split < 0
      ? { key: decoded, secret: null }
      : { key: decoded.slice(0, split), secret: decoded.slice(split + 1) };
  }
  // query string auth, which WooCommerce accepts over HTTPS
  return { key: c.req.query('consumer_key') ?? null, secret: c.req.query('consumer_secret') ?? null };
}

function paginate(c: Context, rows: unknown[]) {
  const perPage = Number(c.req.query('per_page') ?? 10);
  const page = Number(c.req.query('page') ?? 1);
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > MAX_PER_PAGE) {
    return wcError(c, 400, 'rest_invalid_param', 'Invalid parameter(s): per_page', {
      params: { per_page: `per_page must be between 1 (inclusive) and ${MAX_PER_PAGE} (inclusive)` },
    });
  }
  if (!Number.isInteger(page) || page < 1) {
    return wcError(c, 400, 'rest_invalid_param', 'Invalid parameter(s): page');
  }
  const totalPages = Math.ceil(rows.length / perPage);
  if (page > 1 && page > totalPages) {
    return wcError(
      c,
      400,
      'rest_post_invalid_page_number',
      'The page number requested is larger than the number of pages available.',
    );
  }
  c.header('X-WP-Total', String(rows.length));
  c.header('X-WP-TotalPages', String(totalPages));
  return c.json(rows.slice((page - 1) * perPage, page * perPage));
}

function tooMany(c: Context) {
  return wcError(
    c,
    413,
    'woocommerce_rest_request_entity_too_large',
    `Unable to accept more than ${BATCH_LIMIT} items for this request.`,
  );
}

function itemError(id: number, error: { code: string; message: string } | null) {
  const e = error ?? { code: 'woocommerce_rest_product_invalid_id', message: 'Invalid ID.' };
  return { id, error: { code: e.code, message: e.message, data: { status: error ? 400 : 404 } } };
}

async function readJson(c: Context): Promise<ProductPatch | null> {
  try {
    const body: unknown = await c.req.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as ProductPatch) : null;
  } catch {
    return null;
  }
}

function arrayOf(value: unknown): ProductPatch[] {
  return Array.isArray(value) ? (value as ProductPatch[]) : [];
}

/** WooCommerce reads dates without an offset as site time, or as UTC with dates_are_gmt */
function parseWpDate(value: string | undefined, gmt: boolean): number | null {
  if (!value) return null;
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(value);
  const parsed = Date.parse(hasZone ? value : `${value}${gmt ? 'Z' : '+03:00'}`);
  return Number.isNaN(parsed) ? null : parsed;
}
