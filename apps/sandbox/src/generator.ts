import type { SandboxConfig } from './config.js';
import { MOYSKLAD } from './ids.js';
import { toDecimal } from './money.js';
import { OrderFactory } from './orders.js';
import type { Random } from './random.js';
import type { OrderActivity, SandboxState } from './state/sandbox.js';
import type { ShopifyOrder } from './state/shopify.js';
import type { WooOrder } from './state/woocommerce.js';
import {
  type Delivery,
  moyskladProductWebhook,
  moyskladStockWebhook,
  shopifyOrderWebhook,
  type WebhookSender,
  wooOrderWebhook,
} from './webhooks.js';

export interface GeneratorDeps {
  state: SandboxState;
  sender: WebhookSender;
  random: Random;
  config: Pick<SandboxConfig, 'token' | 'publicUrl' | 'generatorMinSec' | 'generatorMaxSec'>;
}

/** Drives the demo: a stream of orders, late payments, stock movements and price changes. */
export class Generator {
  readonly factory: OrderFactory;
  private readonly timers = new Set<NodeJS.Timeout>();
  private priceTurn = 0;
  private running = false;

  constructor(private readonly deps: GeneratorDeps) {
    this.factory = new OrderFactory(deps.state, deps.random);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.after(this.randomDelay(5, 15) * 1000, () => this.orderLoop());
    this.after(this.randomDelay(120, 240) * 1000, () => this.stockLoop());
    this.after(this.randomDelay(8 * 60, 12 * 60) * 1000, () => this.priceLoop());
    console.log(
      `generator on: an order every ${this.deps.config.generatorMinSec}-${this.deps.config.generatorMaxSec} s`,
    );
  }

  stop(): void {
    this.running = false;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  async placeOrder(): Promise<OrderActivity> {
    return this.deps.random.chance(0.6) ? this.placeZernoOrder() : this.placeHillsideOrder();
  }

  async placeZernoOrder(): Promise<OrderActivity> {
    const { order, activity } = this.factory.createZernoOrder();
    const token = this.deps.config.token;
    console.log(`order zerno #${order.id}: ${order.json.total} RUB, ${activity.payment}`);
    await this.notify(activity, (id) => wooOrderWebhook(token, order, 'created', id));
    if (activity.payment === 'later') {
      this.after(this.randomDelay(20, 90) * 1000, () => this.payZerno(order, activity));
    }
    return activity;
  }

  async placeHillsideOrder(): Promise<OrderActivity> {
    const { order, activity } = this.factory.createHillsideOrder();
    const token = this.deps.config.token;
    console.log(
      `order hillside ${order.gql.name}: £${order.gql.totalPriceSet.shopMoney.amount}, ${activity.payment}`,
    );
    await this.notify(activity, (id) => shopifyOrderWebhook(token, order, 'orders/create', id));
    if (activity.payment === 'later') {
      this.after(this.randomDelay(20, 90) * 1000, () => this.payHillside(order, activity));
    }
    return activity;
  }

  async payZerno(order: WooOrder, activity: OrderActivity): Promise<void> {
    this.factory.markZernoPaid(order);
    activity.payment = 'paid';
    await this.notify(activity, (id) => wooOrderWebhook(this.deps.config.token, order, 'updated', id));
  }

  async payHillside(order: ShopifyOrder, activity: OrderActivity): Promise<void> {
    this.factory.markHillsidePaid(order);
    activity.payment = 'paid';
    const token = this.deps.config.token;
    await this.notify(activity, (id) => shopifyOrderWebhook(token, order, 'orders/paid', id));
    await this.deps.sender.send(shopifyOrderWebhook(token, order, 'orders/updated'));
  }

  /** a few warehouse movements in МойСклад, announced with a webhookstock call */
  async changeStock(): Promise<void> {
    const { state, random, config } = this.deps;
    const changedSince = new Date(Date.now() - 1000);
    const candidates = [...state.moysklad.products.values()].filter((p) => p.tracked && !p.archived);
    const now = new Date();
    for (const product of random.sample(candidates, random.int(2, 4))) {
      const current = product.stock.get(MOYSKLAD.mainStoreId) ?? 0;
      const next = random.chance(0.75)
        ? Math.max(0, current - random.int(1, 3))
        : current + random.int(10, 30);
      state.moysklad.setStock(product.id, MOYSKLAD.mainStoreId, next, now);
      console.log(`stock moysklad ${product.article}: ${current} -> ${next}`);
    }
    await this.deps.sender.send(moyskladStockWebhook(config.token, config.publicUrl, changedSince));
  }

  /** one price change, alternating between МойСклад (with a webhook) and Xero (polled by the API) */
  async changePrice(): Promise<void> {
    const { state, random, config } = this.deps;
    const up = random.chance(0.7);
    const factor = 1 + ((up ? 1 : -1) * random.int(3, 8)) / 100;
    if (this.priceTurn++ % 2 === 0) {
      const product = random.pick(
        [...state.moysklad.products.values()].filter((p) => !p.archived && p.tracked),
      );
      const before = product.priceMinor;
      // roubles end in 9: 749 -> 789
      product.priceMinor = Math.max(9_900, Math.round((before * factor) / 1000) * 1000 - 100);
      product.updated = new Date();
      console.log(
        `price moysklad ${product.article}: ${toDecimal(before)} -> ${toDecimal(product.priceMinor)}`,
      );
      await this.deps.sender.send(moyskladProductWebhook(config.token, config.publicUrl, [product.id]));
      return;
    }
    const item = random.pick([...state.xero.items.values()].filter((i) => i.tracked));
    const before = item.priceMinor;
    // pounds end in .45 or .95: 8.95 -> 9.45
    item.priceMinor = Math.max(95, Math.round((before * factor) / 50) * 50 - 5);
    item.updated = new Date();
    console.log(`price xero ${item.Code}: ${toDecimal(before)} -> ${toDecimal(item.priceMinor)}`);
  }

  // About 1 in 20 order webhooks is never sent, so the API's reconciliation has to find the order
  // through the list endpoints; about 1 in 15 arrives twice with the same delivery id.
  private async notify(activity: OrderActivity, build: (deliveryId?: string) => Delivery): Promise<void> {
    const { random, sender } = this.deps;
    if (random.chance(1 / 20)) {
      activity.webhook = 'skipped on purpose, reconciliation should pick it up';
      console.log(`webhook for ${activity.shop} ${activity.number} skipped on purpose`);
      return;
    }
    const delivery = build();
    const outcome = await sender.send(delivery);
    if (random.chance(1 / 15)) {
      const again = await sender.send(delivery);
      activity.webhook = `${outcome}, then resent with the same id: ${again}`;
      return;
    }
    activity.webhook = outcome;
  }

  // the next run is scheduled first, so slow webhook retries never stretch the pace
  private async orderLoop(): Promise<void> {
    const { generatorMinSec, generatorMaxSec } = this.deps.config;
    this.after(this.randomDelay(generatorMinSec, generatorMaxSec) * 1000, () => this.orderLoop());
    await this.placeOrder().catch((err: unknown) => console.error('order generator failed', err));
  }

  private async stockLoop(): Promise<void> {
    this.after(this.randomDelay(2 * 60, 4 * 60) * 1000, () => this.stockLoop());
    await this.changeStock().catch((err: unknown) => console.error('stock change failed', err));
  }

  private async priceLoop(): Promise<void> {
    this.after(this.randomDelay(8 * 60, 12 * 60) * 1000, () => this.priceLoop());
    await this.changePrice().catch((err: unknown) => console.error('price change failed', err));
  }

  private randomDelay(minSec: number, maxSec: number): number {
    return this.deps.random.int(minSec, maxSec);
  }

  private after(ms: number, run: () => Promise<void>): void {
    if (!this.running) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.running) void run();
    }, ms);
    this.timers.add(timer);
  }
}
