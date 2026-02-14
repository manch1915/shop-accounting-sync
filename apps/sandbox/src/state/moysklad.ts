import type { DemoProduct } from '@sas/demo-data';
import { MOYSKLAD, msId } from '../ids.js';
import { addedVat, includedVat } from '../money.js';

export interface MsProductRec {
  id: string;
  name: string;
  code: string;
  article: string;
  externalCode: string;
  barcodes: string[];
  priceMinor: number;
  vat: number | null;
  archived: boolean;
  /** gift certificates never move through a warehouse */
  tracked: boolean;
  stock: Map<string, number>;
  stockChangedAt: Date;
  updated: Date;
}

export interface MsCounterpartyRec {
  id: string;
  name: string;
  externalCode: string;
  email: string | null;
  phone: string | null;
  actualAddress: string | null;
  companyType: string;
  created: Date;
}

export interface MsServiceRec {
  id: string;
  name: string;
  code: string;
  updated: Date;
}

export interface MsPositionRec {
  id: string;
  quantity: number;
  price: number;
  discount: number;
  vat: number;
  vatEnabled: boolean;
  assortment: { type: 'product' | 'service'; id: string };
}

export interface MsOrderRec {
  id: string;
  name: string;
  externalCode: string;
  moment: Date;
  created: Date;
  updated: Date;
  agentId: string;
  storeId: string | null;
  stateId: string | null;
  description: string | null;
  vatEnabled: boolean;
  vatIncluded: boolean;
  positions: MsPositionRec[];
  sum: number;
  vatSum: number;
  payedSum: number;
}

export interface MsPaymentRec {
  id: string;
  name: string;
  moment: Date;
  created: Date;
  agentId: string;
  sum: number;
  paymentPurpose: string;
  operations: Array<{ orderId: string; linkedSum: number }>;
}

export interface MsNamed {
  id: string;
  name: string;
}

export interface MsState extends MsNamed {
  color: number;
  stateType: 'Regular' | 'Successful' | 'Unsuccessful';
}

export class MoySkladAccount {
  readonly products = new Map<string, MsProductRec>();
  readonly counterparties = new Map<string, MsCounterpartyRec>();
  readonly services = new Map<string, MsServiceRec>();
  readonly orders = new Map<string, MsOrderRec>();
  readonly payments = new Map<string, MsPaymentRec>();
  readonly organization: MsNamed = { id: MOYSKLAD.organizationId, name: 'ООО «Зерно и Пар»' };
  readonly stores: MsNamed[] = [
    { id: MOYSKLAD.mainStoreId, name: 'Основной склад' },
    { id: MOYSKLAD.cafeStoreId, name: 'Кофейня на Рубинштейна' },
  ];
  readonly states: MsState[] = [
    { id: msId('state:new'), name: 'Новый', color: 15106326, stateType: 'Regular' },
    { id: msId('state:confirmed'), name: 'Подтверждён', color: 40931, stateType: 'Regular' },
    { id: msId('state:packed'), name: 'Собран', color: 10066329, stateType: 'Regular' },
    { id: msId('state:shipped'), name: 'Отгружен', color: 8825440, stateType: 'Regular' },
    { id: msId('state:delivered'), name: 'Доставлен', color: 34617, stateType: 'Successful' },
    { id: msId('state:cancelled'), name: 'Отменён', color: 10774611, stateType: 'Unsuccessful' },
  ];
  readonly taxRates = [0, 10, 22].map((rate) => ({
    id: msId(`taxrate:${rate}`),
    rate,
    comment: rate === 0 ? 'НДС 0%' : `НДС ${rate}%`,
  }));
  private orderCounter = 0;
  private paymentCounter = 0;
  private codeCounter = 0;

  constructor(catalog: DemoProduct[], now = new Date()) {
    for (const item of catalog) {
      if (item.storeOnly) continue;
      const tracked = !item.untracked;
      // the café keeps a few packs of beans on its shelf, everything else sits in the main warehouse
      const cafe =
        tracked && /-(250|UTRO|VECHER)$/.test(item.sku) ? Math.min(4, Math.floor(item.stock / 6)) : 0;
      const product: MsProductRec = {
        id: msId(`product:${item.sku}`),
        name: item.option ? `${item.name} (${item.option})` : item.name,
        code: this.nextCode(),
        article: item.accountingSku ?? item.sku,
        externalCode: `zp-${item.sku.toLowerCase()}`,
        barcodes: item.barcode ? [item.barcode] : [],
        priceMinor: item.priceMinor,
        vat: item.vat,
        archived: false,
        tracked,
        stock: new Map(
          tracked
            ? [
                [MOYSKLAD.mainStoreId, item.stock - cafe],
                [MOYSKLAD.cafeStoreId, cafe],
              ]
            : [],
        ),
        stockChangedAt: now,
        updated: now,
      };
      this.products.set(product.id, product);
    }
  }

  nextCode(): string {
    this.codeCounter += 1;
    return String(this.codeCounter).padStart(5, '0');
  }

  nextOrderName(): string {
    this.orderCounter += 1;
    return String(this.orderCounter).padStart(5, '0');
  }

  nextPaymentName(): string {
    this.paymentCounter += 1;
    return String(this.paymentCounter).padStart(5, '0');
  }

  totalStock(product: MsProductRec): number {
    let sum = 0;
    for (const qty of product.stock.values()) sum += qty;
    return sum;
  }

  setStock(productId: string, storeId: string, quantity: number, now: Date): void {
    const product = this.products.get(productId);
    if (!product?.tracked) return;
    product.stock.set(storeId, quantity);
    product.stockChangedAt = now;
  }

  hasAssortment(type: string, id: string): boolean {
    return type === 'product' ? this.products.has(id) : type === 'service' && this.services.has(id);
  }
}

/** order totals the way МойСклад computes them, in kopecks */
export function orderTotals(
  positions: MsPositionRec[],
  vatEnabled: boolean,
  vatIncluded: boolean,
): { sum: number; vatSum: number } {
  let sum = 0;
  let vatSum = 0;
  for (const p of positions) {
    const line = Math.round(p.price * p.quantity * (1 - p.discount / 100));
    const rate = vatEnabled && p.vatEnabled ? p.vat : 0;
    const vat = vatIncluded ? includedVat(line, rate) : addedVat(line, rate);
    vatSum += vat;
    sum += vatIncluded ? line : line + vat;
  }
  return { sum, vatSum };
}
