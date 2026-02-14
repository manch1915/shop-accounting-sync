import { type Context, Hono } from 'hono';
import { SHOPIFY } from '../ids.js';
import { fromDecimal, toDecimal } from '../money.js';
import type { SandboxState } from '../state/sandbox.js';
import { gid, parseGid, type ShopifyStore, type ShopifyVariant } from '../state/shopify.js';

type Vars = Record<string, unknown>;
interface UserError {
  field: string[] | null;
  message: string;
  code?: string;
}
interface Result {
  data: unknown;
  requested: number;
  actual: number;
}
type Operation = (store: ShopifyStore, vars: Vars, query: string) => Result | { errors: string[] };

const MAX_FIRST = 250;
const BUCKET_SIZE = 2000;
const RESTORE_PER_SEC = 100;

// No GraphQL engine here: each operation the connector sends is recognised by its root field,
// and the answer carries every field those queries select.
const OPERATIONS: Array<[RegExp, Operation]> = [
  [/\binventorySetQuantities\s*\(/, inventorySet],
  [/\bproductVariantsBulkUpdate\s*\(/, variantsBulkUpdate],
  [/\bproductCreate\s*\(/, productCreate],
  [/\bproductVariants\s*\(/, productVariants],
  [/\borders\s*\(/, orders],
  [/\border\s*\(/, order],
];

class CostBucket {
  private available = BUCKET_SIZE;
  private updatedAt = Date.now();

  status(now = Date.now()) {
    this.available = Math.min(
      BUCKET_SIZE,
      this.available + ((now - this.updatedAt) / 1000) * RESTORE_PER_SEC,
    );
    this.updatedAt = now;
    return {
      maximumAvailable: BUCKET_SIZE,
      currentlyAvailable: Math.floor(this.available),
      restoreRate: RESTORE_PER_SEC,
    };
  }

  /** Shopify checks the requested cost up front and only keeps the actual cost */
  take(requested: number, actual: number): boolean {
    if (this.status().currentlyAvailable < requested) return false;
    this.available -= actual;
    return true;
  }
}

export function shopifyApp(state: SandboxState, token: string): Hono {
  const app = new Hono();
  const bucket = new CostBucket();

  app.post('/', async (c) => {
    if (c.req.header('x-shopify-access-token') !== token) {
      return c.json(
        { errors: '[API] Invalid API key or access token (unrecognized login or wrong password)' },
        401,
      );
    }
    let body: { query?: unknown; variables?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ errors: { query: 'Required parameter missing or invalid' } }, 400);
    }
    if (typeof body.query !== 'string' || !body.query.trim()) {
      return c.json({ errors: { query: 'Required parameter missing or invalid' } }, 400);
    }
    const query = body.query;
    const vars = (body.variables && typeof body.variables === 'object' ? body.variables : {}) as Vars;
    const operation = OPERATIONS.find(([pattern]) => pattern.test(query))?.[1];
    if (!operation) return unknownField(c, query);

    const result = operation(state.shopify, vars, query);
    if ('errors' in result) return c.json({ errors: result.errors.map((message) => ({ message })) });
    if (!bucket.take(result.requested, result.actual)) {
      return c.json({
        errors: [
          {
            message: 'Throttled',
            extensions: { code: 'THROTTLED', documentation: 'https://shopify.dev/api/usage/rate-limits' },
          },
        ],
        extensions: {
          cost: {
            requestedQueryCost: result.requested,
            actualQueryCost: null,
            throttleStatus: bucket.status(),
          },
        },
      });
    }
    return c.json({
      data: result.data,
      extensions: {
        cost: {
          requestedQueryCost: result.requested,
          actualQueryCost: result.actual,
          throttleStatus: bucket.status(),
        },
      },
    });
  });

  app.all('*', (c) => c.json({ errors: 'Not Found' }, 404));
  return app;
}

function unknownField(c: Context, query: string) {
  const field = /\{\s*(\w+)/.exec(query)?.[1] ?? 'unknown';
  const root = /^\s*mutation\b/.test(query) ? 'Mutation' : 'QueryRoot';
  return c.json({
    errors: [
      {
        message: `Field '${field}' doesn't exist on type '${root}'`,
        extensions: { code: 'undefinedField', typeName: root, fieldName: field },
      },
    ],
  });
}

function first(vars: Vars): number | string {
  const value = vars.first ?? 50;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_FIRST) {
    return `The first argument must be between 1 and ${MAX_FIRST}.`;
  }
  return value;
}

function order(store: ShopifyStore, vars: Vars): Result {
  const id = parseGid(vars.id, 'Order');
  const found = id === null ? undefined : store.orders.get(id);
  return { data: { order: found?.gql ?? null }, requested: 642, actual: found ? 48 : 1 };
}

function orders(store: ShopifyStore, vars: Vars, query: string): Result | { errors: string[] } {
  const limit = first(vars);
  if (typeof limit === 'string') return { errors: [limit] };
  const filters = parseSearch(typeof vars.query === 'string' ? vars.query : '');
  const sortKey =
    /sortKey:\s*(\w+)/.exec(query)?.[1] ?? (typeof vars.sortKey === 'string' ? vars.sortKey : 'ID');
  const reverse = /reverse:\s*true/.test(query) || vars.reverse === true;
  const field = sortKey === 'UPDATED_AT' ? 'updatedAt' : sortKey === 'CREATED_AT' ? 'createdAt' : null;
  const after = decodeCursor(vars.after);
  const rows = [...store.orders.values()]
    .filter((o) => filters.every((f) => f(o.gql)))
    .sort((a, b) => (field ? Date.parse(a.gql[field]) - Date.parse(b.gql[field]) : 0) || a.id - b.id);
  if (reverse) rows.reverse();
  const start = after === null ? 0 : rows.findIndex((o) => o.id === after) + 1;
  const page = rows.slice(start, start + limit);
  const last = page.at(-1);
  return {
    data: {
      orders: {
        nodes: page.map((o) => ({ id: o.gql.id, name: o.gql.name, updatedAt: o.gql.updatedAt })),
        pageInfo: {
          hasNextPage: start + limit < rows.length,
          endCursor: last ? encodeCursor(last.id) : null,
        },
      },
    },
    requested: limit + 2,
    actual: page.length + 2,
  };
}

/** the subset of Shopify search syntax we need: updated_at / created_at comparisons */
function parseSearch(search: string): Array<(o: { updatedAt: string; createdAt: string }) => boolean> {
  const out: Array<(o: { updatedAt: string; createdAt: string }) => boolean> = [];
  const pattern = /(updated_at|created_at):(>=|<=|>|<)?'?([^'\s]+)'?/g;
  for (const match of search.matchAll(pattern)) {
    const [, name, op = '=', value = ''] = match;
    const bound = Date.parse(value);
    if (Number.isNaN(bound)) continue;
    const key = name === 'updated_at' ? 'updatedAt' : 'createdAt';
    out.push((o) => {
      const t = Date.parse(o[key]);
      return op === '>'
        ? t > bound
        : op === '>='
          ? t >= bound
          : op === '<'
            ? t < bound
            : op === '<='
              ? t <= bound
              : t === bound;
    });
  }
  return out;
}

function productVariants(store: ShopifyStore, vars: Vars): Result | { errors: string[] } {
  const limit = first(vars);
  if (typeof limit === 'string') return { errors: [limit] };
  const after = decodeCursor(vars.after);
  const all = store.allVariants();
  const start = after === null ? 0 : all.findIndex((v) => v.id === after) + 1;
  const page = all.slice(start, start + limit);
  const last = page.at(-1);
  return {
    data: {
      productVariants: {
        nodes: page.map((v) => variantJson(store, v)),
        pageInfo: { hasNextPage: start + limit < all.length, endCursor: last ? encodeCursor(last.id) : null },
      },
    },
    requested: limit * 6 + 2,
    actual: page.length * 3 + 2,
  };
}

function variantJson(store: ShopifyStore, v: ShopifyVariant) {
  const product = store.products.get(v.productId);
  return {
    id: gid('ProductVariant', v.id),
    title: v.title,
    sku: v.sku || null,
    price: toDecimal(v.priceMinor),
    inventoryQuantity: v.quantity,
    barcode: v.barcode,
    barcodes: { nodes: v.barcode ? [{ value: v.barcode }] : [] },
    product: { id: gid('Product', v.productId), title: product?.title ?? '' },
    inventoryItem: { id: gid('InventoryItem', v.inventoryItemId), tracked: v.tracked },
  };
}

function inventorySet(store: ShopifyStore, vars: Vars): Result {
  const key = typeof vars.idempotencyKey === 'string' ? vars.idempotencyKey : null;
  const replay = key ? store.idempotency.get(key) : undefined;
  if (replay) return { data: replay, requested: 10, actual: 10 };

  const input = (vars.input ?? {}) as Vars;
  const quantities = Array.isArray(input.quantities) ? (input.quantities as Vars[]) : [];
  const errors: UserError[] = [];
  const name = input.name;
  if (name !== 'available' && name !== 'on_hand') {
    errors.push({
      field: ['input', 'name'],
      message: 'The quantity name must be either available or on_hand.',
      code: 'INVALID_NAME',
    });
  }
  const changes: Array<{ variant: ShopifyVariant; quantity: number }> = [];
  for (const [index, row] of quantities.entries()) {
    const at = (field: string) => ['input', 'quantities', String(index), field];
    const itemId = parseGid(row.inventoryItemId, 'InventoryItem');
    const variant = itemId === null ? undefined : store.variantByInventoryItem(itemId);
    if (!variant) {
      errors.push({
        field: at('inventoryItemId'),
        message: 'The specified inventory item could not be found.',
        code: 'INVALID_INVENTORY_ITEM',
      });
      continue;
    }
    if (String(parseGid(row.locationId, 'Location')) !== SHOPIFY.locationId) {
      errors.push({
        field: at('locationId'),
        message: 'The specified location could not be found.',
        code: 'INVALID_LOCATION',
      });
      continue;
    }
    const quantity = row.quantity;
    if (typeof quantity !== 'number' || !Number.isInteger(quantity)) {
      errors.push({
        field: at('quantity'),
        message: 'The quantity must be an integer.',
        code: 'INVALID_QUANTITY',
      });
      continue;
    }
    const compare = row.changeFromQuantity;
    if (compare !== null && compare !== undefined && compare !== variant.quantity) {
      errors.push({
        field: at('changeFromQuantity'),
        message: 'The specified compare quantity is stale.',
        code: 'CHANGE_FROM_QUANTITY_STALE',
      });
      continue;
    }
    changes.push({ variant, quantity });
  }

  // the mutation is all-or-nothing
  const applied = errors.length ? [] : changes;
  for (const { variant, quantity } of applied) variant.quantity = quantity;
  const data = {
    inventorySetQuantities: {
      inventoryAdjustmentGroup: applied.length
        ? {
            createdAt: new Date().toISOString(),
            reason: input.reason ?? 'correction',
            referenceDocumentUri: input.referenceDocumentUri ?? null,
            changes: applied.map(({ variant }) => ({
              name: 'available',
              quantityAfterChange: variant.quantity,
            })),
          }
        : null,
      userErrors: errors,
    },
  };
  if (key) store.idempotency.set(key, data);
  return { data, requested: 10, actual: 10 };
}

function variantsBulkUpdate(store: ShopifyStore, vars: Vars, query: string): Result {
  const product = (() => {
    const id = parseGid(vars.productId, 'Product');
    return id === null ? undefined : store.products.get(id);
  })();
  if (!product) {
    return mutation('productVariantsBulkUpdate', {
      product: null,
      productVariants: null,
      userErrors: [
        { field: ['productId'], message: 'Product does not exist', code: 'PRODUCT_DOES_NOT_EXIST' },
      ],
    });
  }
  const partial = /allowPartialUpdates:\s*true/.test(query) || vars.allowPartialUpdates === true;
  const inputs = Array.isArray(vars.variants) ? (vars.variants as Vars[]) : [];
  const errors: UserError[] = [];
  const valid: Array<() => ShopifyVariant> = [];
  for (const [index, input] of inputs.entries()) {
    const at = (...field: string[]) => ['variants', String(index), ...field];
    const id = parseGid(input.id, 'ProductVariant');
    const variant = product.variants.find((v) => v.id === id);
    if (!variant) {
      errors.push({
        field: at('id'),
        message: 'Product variant does not exist',
        code: 'PRODUCT_VARIANT_DOES_NOT_EXIST',
      });
      continue;
    }
    const price = input.price === undefined ? null : fromDecimal(String(input.price));
    if (price !== null && (Number.isNaN(price) || price < 0)) {
      errors.push({
        field: at('price'),
        message: 'Price must be greater than or equal to 0',
        code: 'GREATER_THAN_OR_EQUAL_TO',
      });
      continue;
    }
    valid.push(() => {
      if (price !== null) variant.priceMinor = price;
      // 2026-10 takes the plain `barcode` string; the list form is accepted too
      const barcodes = Array.isArray(input.barcodes) ? (input.barcodes as Array<{ value?: unknown }>) : null;
      const barcode = typeof input.barcode === 'string' ? input.barcode : barcodes?.[0]?.value;
      if (typeof barcode === 'string') variant.barcode = barcode || null;
      const item = (input.inventoryItem ?? {}) as Vars;
      if (typeof item.sku === 'string') variant.sku = item.sku;
      if (typeof item.tracked === 'boolean') variant.tracked = item.tracked;
      return variant;
    });
  }
  const updated = errors.length && !partial ? [] : valid.map((apply) => apply());
  if (updated.length) product.updatedAt = new Date();
  return mutation('productVariantsBulkUpdate', {
    product: { id: gid('Product', product.id) },
    productVariants: updated.map((v) => ({
      id: gid('ProductVariant', v.id),
      price: toDecimal(v.priceMinor),
    })),
    userErrors: errors,
  });
}

function productCreate(store: ShopifyStore, vars: Vars): Result | { errors: string[] } {
  const input = vars.product as Vars | undefined;
  if (!input || typeof input !== 'object') {
    return { errors: ['Variable $product of type ProductCreateInput! was provided invalid value'] };
  }
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) {
    return mutation('productCreate', {
      product: null,
      userErrors: [{ field: ['title'], message: "Title can't be blank" }],
    });
  }
  const status = input.status === 'ACTIVE' || input.status === 'ARCHIVED' ? input.status : 'DRAFT';
  const description = typeof input.descriptionHtml === 'string' ? input.descriptionHtml : '';
  const product = store.newProduct(title, status, description, new Date());
  const variant = store.newVariant(product, 'Default Title');
  return mutation('productCreate', {
    product: {
      id: gid('Product', product.id),
      title: product.title,
      status: product.status,
      variants: {
        nodes: [
          {
            id: gid('ProductVariant', variant.id),
            inventoryItem: { id: gid('InventoryItem', variant.inventoryItemId) },
          },
        ],
      },
    },
    userErrors: [],
  });
}

function mutation(field: string, payload: unknown): Result {
  return { data: { [field]: payload }, requested: 10, actual: 10 };
}

function encodeCursor(id: number): string {
  return Buffer.from(JSON.stringify({ last_id: id })).toString('base64');
}

function decodeCursor(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as { last_id?: unknown };
    return typeof parsed.last_id === 'number' ? parsed.last_id : null;
  } catch {
    return null;
  }
}
