import { HILLSIDE_PRODUCTS, ZERNO_PRODUCTS } from '@sas/demo-data';
import { orderNumberBase } from '../ids.js';
import { MoySkladAccount } from './moysklad.js';
import { ShopifyStore } from './shopify.js';
import { WooStore } from './woocommerce.js';
import { XeroOrg } from './xero.js';

export type ShopKey = 'zerno' | 'hillside';

/** one line per generated order, for the status page */
export interface OrderActivity {
  shop: ShopKey;
  id: string;
  number: string;
  customer: string;
  totalMinor: number;
  currency: string;
  payment: 'paid' | 'later' | 'pending';
  notes: string[];
  createdAt: Date;
  webhook: string;
}

export interface WebhookActivity {
  at: Date;
  connectionId: string;
  topic: string;
  deliveryId: string;
  outcome: string;
}

const KEEP = 200;

export class ActivityLog {
  readonly orders: OrderActivity[] = [];
  readonly webhooks: WebhookActivity[] = [];

  addOrder(entry: OrderActivity): OrderActivity {
    this.orders.unshift(entry);
    this.orders.length = Math.min(this.orders.length, KEEP);
    return entry;
  }

  addWebhook(entry: WebhookActivity): void {
    this.webhooks.unshift(entry);
    this.webhooks.length = Math.min(this.webhooks.length, KEEP);
  }
}

export interface SandboxState {
  woo: WooStore;
  shopify: ShopifyStore;
  moysklad: MoySkladAccount;
  xero: XeroOrg;
  activity: ActivityLog;
  startedAt: Date;
}

export function createState(token: string, now = new Date()): SandboxState {
  const base = orderNumberBase(now.getTime());
  return {
    woo: new WooStore(ZERNO_PRODUCTS, base, now),
    shopify: new ShopifyStore(HILLSIDE_PRODUCTS, base, now),
    moysklad: new MoySkladAccount(ZERNO_PRODUCTS, now),
    xero: new XeroOrg(HILLSIDE_PRODUCTS, token, now),
    activity: new ActivityLog(),
    startedAt: now,
  };
}
