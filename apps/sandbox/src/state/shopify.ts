import type { DemoProduct } from '@sas/demo-data';

export type GidType = 'Order' | 'Product' | 'ProductVariant' | 'InventoryItem' | 'Location' | 'Customer';

export const gid = (type: GidType | string, id: number | string): string => `gid://shopify/${type}/${id}`;

/** numeric id from a gid or a plain id, null for anything else */
export function parseGid(value: unknown, type: GidType): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  const match = /^gid:\/\/shopify\/(\w+)\/(\d+)$/.exec(text);
  if (match) return match[1] === type ? Number(match[2]) : null;
  return /^\d+$/.test(text) ? Number(text) : null;
}

export interface ShopifyVariant {
  id: number;
  productId: number;
  title: string;
  sku: string;
  barcode: string | null;
  priceMinor: number;
  inventoryItemId: number;
  tracked: boolean;
  quantity: number;
  vat: number | null;
}

export interface ShopifyProduct {
  id: number;
  title: string;
  status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
  descriptionHtml: string;
  storeOnly: boolean;
  variants: ShopifyVariant[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ShopifySellable {
  product: ShopifyProduct;
  variant: ShopifyVariant;
  sku: string;
  name: string;
  priceMinor: number;
  vat: number | null;
  storeOnly: boolean;
  tracked: boolean;
  stock: number;
}

export interface MoneyBag {
  shopMoney: { amount: string; currencyCode: string };
}

export interface ShopifyTransaction {
  id: string;
  kind: 'SALE' | 'AUTHORIZATION' | 'CAPTURE';
  status: 'SUCCESS' | 'PENDING';
  gateway: string;
  processedAt: string | null;
  amountSet: MoneyBag;
}

export interface GqlTaxLineJson {
  title: string;
  ratePercentage: number;
  priceSet: MoneyBag;
}

export interface GqlAddressJson {
  address1: string;
  address2: string | null;
  city: string;
  zip: string;
  province: string | null;
  countryCodeV2: string;
  company: string | null;
  firstName: string;
  lastName: string;
  phone: string;
}

export interface GqlLineItemJson {
  id: string;
  name: string;
  sku: string | null;
  quantity: number;
  variant: { id: string };
  product: { id: string };
  originalUnitPriceSet: MoneyBag;
  originalTotalSet: MoneyBag;
  discountAllocations: Array<{ allocatedAmountSet: MoneyBag }>;
  taxLines: GqlTaxLineJson[];
}

export interface GqlOrderJson {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  displayFinancialStatus: 'PAID' | 'AUTHORIZED' | 'PENDING';
  currencyCode: string;
  taxesIncluded: boolean;
  note: string | null;
  email: string | null;
  phone: string | null;
  customer: {
    id: string;
    firstName: string;
    lastName: string;
    defaultEmailAddress: { emailAddress: string };
    defaultPhoneNumber: { phoneNumber: string };
  } | null;
  shippingAddress: GqlAddressJson;
  billingAddress: GqlAddressJson;
  discountCodes: string[];
  lineItems: { nodes: GqlLineItemJson[] };
  shippingLines: {
    nodes: Array<{
      title: string;
      isRemoved: boolean;
      discountedPriceSet: MoneyBag;
      taxLines: GqlTaxLineJson[];
    }>;
  };
  subtotalPriceSet: MoneyBag;
  totalDiscountsSet: MoneyBag;
  totalShippingPriceSet: MoneyBag;
  totalPriceSet: MoneyBag;
  totalTaxSet: MoneyBag;
  transactions: ShopifyTransaction[];
}

export interface ShopifyOrder {
  id: number;
  number: number;
  gql: GqlOrderJson;
}

// Shopify ids are large and unrelated across resources; fixed bases keep them readable in the journal
const PRODUCT_BASE = 9_100_000_000_000;
const VARIANT_BASE = 47_100_000_000_000;
const INVENTORY_BASE = 49_100_000_000_000;
export const ORDER_ID_BASE = 6_100_000_000_000;

export class ShopifyStore {
  readonly products = new Map<number, ShopifyProduct>();
  readonly orders = new Map<number, ShopifyOrder>();
  /** inventorySetQuantities answers, by idempotency key */
  readonly idempotency = new Map<string, unknown>();
  private nextProduct = 1;
  private nextVariant = 1;
  nextOrderNumber: number;
  nextLineId = 1;
  nextTransactionId = 1;

  constructor(catalog: DemoProduct[], orderBase: number, now = new Date()) {
    this.nextOrderNumber = orderBase;
    const groups = new Map<string, DemoProduct[]>();
    for (const item of catalog) {
      if (item.accountingOnly) continue;
      const key = item.parent ?? item.sku;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    let index = 0;
    for (const items of groups.values()) {
      const first = items[0];
      if (!first) continue;
      const product = this.newProduct(first.name, 'ACTIVE', '', now);
      product.storeOnly = Boolean(first.storeOnly);
      for (const item of items) {
        const variant = this.newVariant(product, item.option ?? 'Default Title');
        variant.sku = item.sku;
        variant.barcode = item.barcode;
        variant.priceMinor = item.priceMinor;
        variant.tracked = !item.untracked;
        variant.vat = item.vat;
        // a few store copies start behind the warehouse so the first stock sync has work to do
        variant.quantity = item.untracked ? 0 : index++ % 4 === 2 ? item.stock + 3 : item.stock;
      }
    }
  }

  newProduct(
    title: string,
    status: ShopifyProduct['status'],
    descriptionHtml: string,
    now: Date,
  ): ShopifyProduct {
    const id = PRODUCT_BASE + this.nextProduct++ * 10;
    const product: ShopifyProduct = {
      id,
      title,
      status,
      descriptionHtml,
      storeOnly: false,
      variants: [],
      createdAt: now,
      updatedAt: now,
    };
    this.products.set(id, product);
    return product;
  }

  newVariant(product: ShopifyProduct, title: string): ShopifyVariant {
    const n = this.nextVariant++;
    const variant: ShopifyVariant = {
      id: VARIANT_BASE + n,
      productId: product.id,
      title,
      sku: '',
      barcode: null,
      priceMinor: 0,
      inventoryItemId: INVENTORY_BASE + n,
      // new variants are not tracked until someone turns tracking on
      tracked: false,
      quantity: 0,
      vat: 20,
    };
    product.variants.push(variant);
    return variant;
  }

  allVariants(): ShopifyVariant[] {
    return [...this.products.values()].flatMap((p) => p.variants).sort((a, b) => a.id - b.id);
  }

  variantByInventoryItem(inventoryItemId: number): ShopifyVariant | undefined {
    return this.allVariants().find((v) => v.inventoryItemId === inventoryItemId);
  }

  sellables(): ShopifySellable[] {
    const out: ShopifySellable[] = [];
    for (const product of this.products.values()) {
      if (product.status !== 'ACTIVE') continue;
      for (const variant of product.variants) {
        out.push({
          product,
          variant,
          sku: variant.sku,
          name: variant.title === 'Default Title' ? product.title : `${product.title} - ${variant.title}`,
          priceMinor: variant.priceMinor,
          vat: variant.vat,
          storeOnly: product.storeOnly,
          tracked: variant.tracked,
          stock: variant.quantity,
        });
      }
    }
    return out;
  }

  reduceStock(item: ShopifySellable, quantity: number): void {
    if (item.tracked) item.variant.quantity -= quantity;
  }

  addOrder(order: ShopifyOrder): ShopifyOrder {
    this.orders.set(order.id, order);
    return order;
  }
}
