import type { DemoProduct } from '@sas/demo-data';
import { WOOCOMMERCE } from '../ids.js';
import { toDecimal } from '../money.js';
import { wpGmt, wpLocal } from './clock.js';

export interface WooVariation {
  id: number;
  parentId: number;
  sku: string;
  barcode: string | null;
  priceMinor: number;
  manageStock: boolean;
  stock: number | null;
  option: string;
  vat: number | null;
  createdAt: Date;
  modifiedAt: Date;
}

export interface WooProduct {
  id: number;
  name: string;
  type: 'simple' | 'variable';
  status: 'publish' | 'draft' | 'pending' | 'private';
  sku: string;
  barcode: string | null;
  priceMinor: number;
  manageStock: boolean;
  stock: number | null;
  vat: number | null;
  description: string;
  storeOnly: boolean;
  attributeName: string;
  variations: WooVariation[];
  createdAt: Date;
  modifiedAt: Date;
}

/** what the order factory can put into a cart */
export interface WooSellable {
  product: WooProduct;
  variation: WooVariation | null;
  sku: string;
  name: string;
  priceMinor: number;
  vat: number | null;
  storeOnly: boolean;
  tracked: boolean;
  stock: number;
}

export interface WooOrder {
  id: number;
  json: WcOrderJson;
}

export interface WcOrderJson {
  id: number;
  number: string;
  status: string;
  date_created_gmt: string;
  date_modified: string;
  date_modified_gmt: string;
  date_paid: string | null;
  date_paid_gmt: string | null;
  total: string;
  currency: string;
  billing: { first_name: string; last_name: string; email: string; [key: string]: unknown };
  [key: string]: unknown;
}

export type ProductPatch = Record<string, unknown>;

const STOCK_FIELDS = ['manage_stock', 'stock_quantity'] as const;

export class WooStore {
  readonly products = new Map<number, WooProduct>();
  readonly orders = new Map<number, WooOrder>();
  private nextPostId = 300;
  nextOrderId: number;
  nextLineId: number;

  constructor(catalog: DemoProduct[], orderBase: number, now = new Date()) {
    this.nextOrderId = orderBase;
    this.nextLineId = orderBase * 10;
    const groups = new Map<string, DemoProduct[]>();
    for (const item of catalog) {
      if (item.accountingOnly) continue;
      const key = item.parent ?? item.sku;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    let index = 0;
    for (const [key, items] of groups) {
      const first = items[0];
      if (!first) continue;
      const variable = Boolean(first.parent);
      const product: WooProduct = {
        id: this.nextPostId++,
        name: first.name,
        type: variable ? 'variable' : 'simple',
        status: 'publish',
        sku: variable ? key : first.sku,
        barcode: variable ? null : first.barcode,
        priceMinor: first.priceMinor,
        manageStock: !variable && !first.untracked,
        stock: variable || first.untracked ? null : staleStock(first.stock, index++),
        vat: first.vat,
        description: '',
        storeOnly: Boolean(first.storeOnly),
        attributeName: 'Тип',
        variations: [],
        createdAt: now,
        modifiedAt: now,
      };
      if (variable) {
        for (const item of items) {
          product.variations.push({
            id: this.nextPostId++,
            parentId: product.id,
            sku: item.sku,
            barcode: item.barcode,
            priceMinor: item.priceMinor,
            manageStock: true,
            stock: staleStock(item.stock, index++),
            option: item.option ?? item.sku,
            vat: item.vat,
            createdAt: now,
            modifiedAt: now,
          });
        }
      }
      this.products.set(product.id, product);
    }
  }

  sellables(): WooSellable[] {
    const out: WooSellable[] = [];
    for (const product of this.products.values()) {
      if (product.status !== 'publish') continue;
      if (product.type === 'simple') {
        out.push({
          product,
          variation: null,
          sku: product.sku,
          name: product.name,
          priceMinor: product.priceMinor,
          vat: product.vat,
          storeOnly: product.storeOnly,
          tracked: product.manageStock,
          stock: product.stock ?? 0,
        });
        continue;
      }
      for (const variation of product.variations) {
        out.push({
          product,
          variation,
          sku: variation.sku,
          name: `${product.name} (${variation.option})`,
          priceMinor: variation.priceMinor,
          vat: variation.vat,
          storeOnly: product.storeOnly,
          tracked: variation.manageStock,
          stock: variation.stock ?? 0,
        });
      }
    }
    return out;
  }

  findVariation(productId: number, variationId: number): WooVariation | undefined {
    return this.products.get(productId)?.variations.find((v) => v.id === variationId);
  }

  /** shops reduce stock when an order is placed; the accounting system stays the source of truth */
  reduceStock(item: WooSellable, quantity: number, now: Date): void {
    const target = item.variation ?? item.product;
    if (!item.tracked || target.stock === null) return;
    target.stock -= quantity;
    target.modifiedAt = now;
  }

  addOrder(json: WcOrderJson): WooOrder {
    const order = { id: json.id, json };
    this.orders.set(order.id, order);
    return order;
  }

  createProduct(body: ProductPatch, now: Date): WooProduct | { code: string; message: string } {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const sku = typeof body.sku === 'string' ? body.sku.trim() : '';
    if (sku && this.skuTaken(sku)) {
      return { code: 'product_invalid_sku', message: 'Invalid or duplicated SKU.' };
    }
    const product: WooProduct = {
      id: this.nextPostId++,
      name: name || 'Товар',
      type: 'simple',
      status: isStatus(body.status) ? body.status : 'publish',
      sku,
      barcode:
        typeof body.global_unique_id === 'string' && body.global_unique_id ? body.global_unique_id : null,
      priceMinor: 0,
      manageStock: false,
      stock: null,
      vat: 22,
      description: typeof body.description === 'string' ? body.description : '',
      storeOnly: false,
      attributeName: 'Тип',
      variations: [],
      createdAt: now,
      modifiedAt: now,
    };
    const error = applyPatch(product, body);
    if (error) return error;
    this.products.set(product.id, product);
    return product;
  }

  updateProduct(id: number, patch: ProductPatch, now: Date) {
    const product = this.products.get(id);
    if (!product) return { code: 'woocommerce_rest_product_invalid_id', message: 'Invalid ID.' };
    if (typeof patch.sku === 'string' && patch.sku !== product.sku && this.skuTaken(patch.sku)) {
      return { code: 'product_invalid_sku', message: 'Invalid or duplicated SKU.' };
    }
    const error = applyPatch(product, patch);
    if (error) return error;
    if (typeof patch.sku === 'string') product.sku = patch.sku;
    product.modifiedAt = now;
    return null;
  }

  updateVariation(productId: number, id: number, patch: ProductPatch, now: Date) {
    const variation = this.findVariation(productId, id);
    if (!variation) {
      return { code: 'woocommerce_rest_product_variation_invalid_id', message: 'Invalid ID.' };
    }
    const error = applyPatch(variation, patch);
    if (error) return error;
    variation.modifiedAt = now;
    return null;
  }

  productJson(p: WooProduct) {
    const prices = p.type === 'variable' ? p.variations.map((v) => v.priceMinor) : [p.priceMinor];
    const price = prices.length ? Math.min(...prices) : 0;
    const inStock =
      p.type === 'variable' ? p.variations.some(inStockVariation) : !p.manageStock || (p.stock ?? 0) > 0;
    return {
      id: p.id,
      name: p.name,
      slug: `product-${p.id}`,
      permalink: `${WOOCOMMERCE.siteUrl}/product/product-${p.id}/`,
      date_created: wpLocal(p.createdAt),
      date_created_gmt: wpGmt(p.createdAt),
      date_modified: wpLocal(p.modifiedAt),
      date_modified_gmt: wpGmt(p.modifiedAt),
      type: p.type,
      status: p.status,
      featured: false,
      catalog_visibility: 'visible',
      description: p.description,
      short_description: '',
      sku: p.sku,
      global_unique_id: p.barcode ?? '',
      price: toDecimal(price),
      regular_price: p.type === 'simple' ? toDecimal(p.priceMinor) : '',
      sale_price: '',
      on_sale: false,
      purchasable: p.status === 'publish',
      virtual: p.type === 'simple' && !p.manageStock && p.vat === null,
      downloadable: false,
      tax_status: p.vat === null ? 'none' : 'taxable',
      tax_class: '',
      manage_stock: p.manageStock,
      stock_quantity: p.manageStock ? p.stock : null,
      stock_status: inStock ? 'instock' : 'outofstock',
      backorders: 'no',
      categories: [],
      attributes:
        p.type === 'variable'
          ? [
              {
                id: 0,
                name: p.attributeName,
                position: 0,
                visible: true,
                variation: true,
                options: p.variations.map((v) => v.option),
              },
            ]
          : [],
      variations: p.variations.map((v) => v.id),
      meta_data: [],
    };
  }

  variationJson(p: WooProduct, v: WooVariation) {
    return {
      id: v.id,
      date_created: wpLocal(v.createdAt),
      date_created_gmt: wpGmt(v.createdAt),
      date_modified: wpLocal(v.modifiedAt),
      date_modified_gmt: wpGmt(v.modifiedAt),
      description: '',
      permalink: `${WOOCOMMERCE.siteUrl}/product/product-${p.id}/?attribute_pa_type=${encodeURIComponent(v.option)}`,
      sku: v.sku,
      global_unique_id: v.barcode ?? '',
      price: toDecimal(v.priceMinor),
      regular_price: toDecimal(v.priceMinor),
      sale_price: '',
      on_sale: false,
      status: 'publish',
      purchasable: true,
      virtual: false,
      downloadable: false,
      tax_status: v.vat === null ? 'none' : 'taxable',
      tax_class: '',
      manage_stock: v.manageStock,
      stock_quantity: v.manageStock ? v.stock : null,
      stock_status: inStockVariation(v) ? 'instock' : 'outofstock',
      backorders: 'no',
      attributes: [{ id: 0, name: p.attributeName, option: v.option }],
      menu_order: 0,
      meta_data: [],
    };
  }

  private skuTaken(sku: string): boolean {
    for (const p of this.products.values()) {
      if (p.sku === sku || p.variations.some((v) => v.sku === sku)) return true;
    }
    return false;
  }
}

function inStockVariation(v: WooVariation): boolean {
  return !v.manageStock || (v.stock ?? 0) > 0;
}

function isStatus(value: unknown): value is WooProduct['status'] {
  return value === 'publish' || value === 'draft' || value === 'pending' || value === 'private';
}

interface Patchable {
  priceMinor: number;
  manageStock: boolean;
  stock: number | null;
  barcode: string | null;
  status?: WooProduct['status'];
  name?: string;
}

function applyPatch(target: Patchable, patch: ProductPatch): { code: string; message: string } | null {
  if (patch.regular_price !== undefined) {
    const text = String(patch.regular_price);
    if (!/^\d+(\.\d{1,2})?$/.test(text)) {
      return { code: 'rest_invalid_param', message: 'Invalid parameter(s): regular_price' };
    }
    target.priceMinor = Math.round(Number(text) * 100);
  }
  for (const field of STOCK_FIELDS) {
    if (patch[field] === undefined) continue;
    if (field === 'manage_stock') target.manageStock = patch.manage_stock === true;
    if (field === 'stock_quantity') {
      const qty = Number(patch.stock_quantity);
      if (!Number.isInteger(qty)) {
        return { code: 'rest_invalid_param', message: 'Invalid parameter(s): stock_quantity' };
      }
      target.stock = qty;
    }
  }
  if (target.manageStock && target.stock === null) target.stock = 0;
  if (typeof patch.global_unique_id === 'string') target.barcode = patch.global_unique_id || null;
  if ('status' in target && isStatus(patch.status)) target.status = patch.status;
  if ('name' in target && typeof patch.name === 'string' && patch.name.trim())
    target.name = patch.name.trim();
  return null;
}

// a few store copies start slightly behind the warehouse, so the first stock sync has real work to do
function staleStock(stock: number, index: number): number {
  return index % 4 === 1 ? stock + 2 : stock;
}
