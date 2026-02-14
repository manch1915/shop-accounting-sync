import { randomUUID } from 'node:crypto';
import {
  type DemoCustomer,
  HILLSIDE_SHIPPING,
  RU_CUSTOMERS,
  UK_CUSTOMERS,
  ZERNO_SHIPPING,
} from '@sas/demo-data';
import { includedVat, percentOf, toDecimal } from './money.js';
import type { Random } from './random.js';
import { wpGmt, wpLocal } from './state/clock.js';
import type { OrderActivity, SandboxState } from './state/sandbox.js';
import {
  type GqlOrderJson,
  gid,
  type MoneyBag,
  ORDER_ID_BASE,
  type ShopifyOrder,
  type ShopifyTransaction,
} from './state/shopify.js';
import type { WcOrderJson, WooOrder } from './state/woocommerce.js';

export type PaymentPlan = 'paid' | 'later' | 'pending';

export interface OrderOptions {
  payment?: PaymentPlan;
  /** put one product that accounting does not know into the cart */
  withStoreOnly?: boolean;
  /** coupon percent, null for none */
  discountPercent?: number | null;
  customer?: DemoCustomer;
  /** a wholesale order from a company customer, big enough to trip Xero's demo limit */
  bulk?: boolean;
  now?: Date;
}

interface CartLine<T> {
  item: T;
  quantity: number;
  gross: number;
  discount: number;
  tax: number;
  /** VAT inside the undiscounted amount */
  subtotalTax: number;
}

interface Sellable {
  sku: string;
  priceMinor: number;
  vat: number | null;
  storeOnly: boolean;
  tracked: boolean;
  stock: number;
}

const ZERNO_NOTES = [
  'Позвонить за час до доставки',
  'Домофон не работает, наберите по телефону',
  'Помолоть под турку, пожалуйста',
  'Можно оставить у консьержа',
];
const HILLSIDE_NOTES = [
  'Please leave with the neighbour at no. 29 if I am out',
  'It is a gift, please leave out the receipt',
  'Side gate is unlocked',
];
const ZERNO_COUPONS = ['ZERNO10', 'AUTUMN', 'DRIP15', 'WELCOME5'];
const HILLSIDE_COUPONS = ['WELCOME10', 'STEEP15', 'AUTUMNTEA', 'LOYAL5'];
const RATE_IDS: Record<number, number> = { 22: 1, 10: 2, 0: 3 };

export const wooCustomerId = (index: number): number => 87 + index * 3;
export const shopifyCustomerId = (index: number): number => 7_712_345_601 + index;

const shopifyTime = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
const money = (minor: number): MoneyBag => ({ shopMoney: { amount: toDecimal(minor), currencyCode: 'GBP' } });

export class OrderFactory {
  constructor(
    private readonly state: SandboxState,
    private readonly random: Random,
  ) {}

  planPayment(): PaymentPlan {
    const roll = this.random.next();
    return roll < 0.65 ? 'paid' : roll < 0.9 ? 'later' : 'pending';
  }

  createZernoOrder(options: OrderOptions = {}): { order: WooOrder; activity: OrderActivity } {
    const now = options.now ?? new Date();
    const woo = this.state.woo;
    const payment = options.payment ?? this.planPayment();
    const withStoreOnly = options.withStoreOnly ?? this.random.chance(1 / 12);
    const percent = options.discountPercent !== undefined ? options.discountPercent : this.couponPercent();
    const customerIndex = options.customer
      ? RU_CUSTOMERS.indexOf(options.customer)
      : this.random.int(0, RU_CUSTOMERS.length - 1);
    const customer = RU_CUSTOMERS[customerIndex] ?? options.customer ?? RU_CUSTOMERS[0];
    if (!customer) throw new Error('no demo customers');

    const cart = this.priceCart(this.pickItems(woo.sellables(), withStoreOnly, false), percent);
    const shipping = this.random.pick(ZERNO_SHIPPING);
    const shipTax = includedVat(shipping.priceMinor, 22);
    const id = woo.nextOrderId++;
    const createdAt = new Date(now.getTime() - this.random.int(5, 40) * 1000);
    const paidAt = payment === 'paid' ? now : null;

    const rates = new Map<number, { tax: number; shipping: number }>();
    for (const line of cart) {
      if (line.item.vat === null) continue;
      const entry = rates.get(line.item.vat) ?? { tax: 0, shipping: 0 };
      entry.tax += line.tax;
      rates.set(line.item.vat, entry);
    }
    const shipEntry = rates.get(22) ?? { tax: 0, shipping: 0 };
    shipEntry.shipping += shipTax;
    rates.set(22, shipEntry);

    const lineTax = sum(cart.map((l) => l.tax));
    const discountGross = sum(cart.map((l) => l.discount));
    const discountTax = sum(cart.map((l) => l.subtotalTax - l.tax));
    const total = sum(cart.map((l) => l.gross - l.discount)) + shipping.priceMinor;
    const pickup = shipping.priceMinor === 0;
    const address = {
      first_name: customer.firstName,
      last_name: customer.lastName,
      company: customer.company ?? '',
      address_1: customer.address,
      address_2: '',
      city: customer.city,
      state: customer.region ?? '',
      postcode: customer.postcode,
      country: 'RU',
    };
    const lineId = () => woo.nextLineId++;
    const coupon = percent ? this.random.pick(ZERNO_COUPONS) : null;
    const note = this.random.chance(0.2) ? this.random.pick(ZERNO_NOTES) : '';

    const json: WcOrderJson = {
      id,
      parent_id: 0,
      status: payment === 'paid' ? 'processing' : payment === 'later' ? 'pending' : 'on-hold',
      currency: 'RUB',
      version: '9.8.2',
      prices_include_tax: true,
      date_created: wpLocal(createdAt),
      date_modified: wpLocal(now),
      discount_total: toDecimal(discountGross - discountTax),
      discount_tax: toDecimal(discountTax),
      shipping_total: toDecimal(shipping.priceMinor - shipTax),
      shipping_tax: toDecimal(shipTax),
      cart_tax: toDecimal(lineTax),
      total: toDecimal(total),
      total_tax: toDecimal(lineTax + shipTax),
      customer_id: customer.registered ? wooCustomerId(customerIndex) : 0,
      order_key: `wc_order_${randomUUID().replaceAll('-', '').slice(0, 13)}`,
      billing: { ...address, email: customer.email, phone: customer.phone },
      shipping: pickup
        ? { ...emptyAddress(), first_name: customer.firstName, last_name: customer.lastName, phone: '' }
        : { ...address, phone: customer.phone },
      payment_method: payment === 'pending' ? 'bacs' : 'yookassa',
      payment_method_title: payment === 'pending' ? 'Оплата по счёту' : 'ЮKassa',
      transaction_id: paidAt ? randomUUID() : '',
      customer_ip_address: `185.71.${this.random.int(1, 254)}.${this.random.int(1, 254)}`,
      customer_user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15',
      created_via: 'checkout',
      customer_note: note,
      date_completed: null,
      date_paid: paidAt ? wpLocal(paidAt) : null,
      cart_hash: randomUUID().replaceAll('-', ''),
      number: String(id),
      meta_data: [],
      line_items: cart.map((line) => {
        const { item } = line;
        const after = line.gross - line.discount;
        const rateId = item.vat === null ? null : (RATE_IDS[item.vat] ?? 1);
        return {
          id: lineId(),
          name: item.name,
          product_id: item.product.id,
          variation_id: item.variation?.id ?? 0,
          quantity: line.quantity,
          tax_class: '',
          subtotal: toDecimal(line.gross - line.subtotalTax),
          subtotal_tax: toDecimal(line.subtotalTax),
          total: toDecimal(after - line.tax),
          total_tax: toDecimal(line.tax),
          taxes:
            rateId === null
              ? []
              : [{ id: rateId, total: toDecimal(line.tax), subtotal: toDecimal(line.subtotalTax) }],
          meta_data: item.variation
            ? [
                {
                  id: lineId(),
                  key: 'pa_type',
                  value: item.variation.option,
                  display_key: item.product.attributeName,
                  display_value: item.variation.option,
                },
              ]
            : [],
          sku: item.sku,
          price: Number(((after - line.tax) / line.quantity / 100).toFixed(4)),
          image: { id: '', src: '' },
          parent_name: item.variation ? item.product.name : null,
        };
      }),
      tax_lines: [...rates.entries()].map(([rate, totals]) => ({
        id: lineId(),
        rate_code: `RU-НДС-${RATE_IDS[rate] ?? 1}`,
        rate_id: RATE_IDS[rate] ?? 1,
        label: 'НДС',
        compound: false,
        tax_total: toDecimal(totals.tax),
        shipping_tax_total: toDecimal(totals.shipping),
        rate_percent: rate,
        meta_data: [],
      })),
      shipping_lines: [
        {
          id: lineId(),
          method_title: shipping.title,
          method_id: pickup ? 'local_pickup' : 'flat_rate',
          instance_id: pickup ? '3' : '1',
          total: toDecimal(shipping.priceMinor - shipTax),
          total_tax: toDecimal(shipTax),
          taxes: [{ id: 1, total: toDecimal(shipTax), subtotal: '' }],
          meta_data: [],
        },
      ],
      fee_lines: [],
      coupon_lines: coupon
        ? [
            {
              id: lineId(),
              code: coupon.toLowerCase(),
              discount: toDecimal(discountGross - discountTax),
              discount_tax: toDecimal(discountTax),
              meta_data: [],
            },
          ]
        : [],
      refunds: [],
      payment_url: `https://zerno-i-par.example/checkout/order-pay/${id}/`,
      is_editable: payment !== 'paid',
      needs_payment: payment !== 'paid',
      needs_processing: true,
      date_created_gmt: wpGmt(createdAt),
      date_modified_gmt: wpGmt(now),
      date_completed_gmt: null,
      date_paid_gmt: paidAt ? wpGmt(paidAt) : null,
      currency_symbol: '₽',
    };

    for (const line of cart) woo.reduceStock(line.item, line.quantity, now);
    const order = woo.addOrder(json);
    const activity = this.state.activity.addOrder({
      shop: 'zerno',
      id: String(id),
      number: String(id),
      customer: `${customer.firstName} ${customer.lastName}${customer.registered ? '' : ' (гость)'}`,
      totalMinor: total,
      currency: 'RUB',
      payment,
      notes: notes(cart, withStoreOnly, percent, false),
      createdAt,
      webhook: 'not sent yet',
    });
    return { order, activity };
  }

  markZernoPaid(order: WooOrder, now = new Date()): void {
    const json = order.json;
    json.status = 'processing';
    json.date_paid = wpLocal(now);
    json.date_paid_gmt = wpGmt(now);
    json.date_modified = wpLocal(now);
    json.date_modified_gmt = wpGmt(now);
    json.transaction_id = randomUUID();
    json.needs_payment = false;
    json.is_editable = false;
  }

  createHillsideOrder(options: OrderOptions = {}): { order: ShopifyOrder; activity: OrderActivity } {
    const now = options.now ?? new Date();
    const shop = this.state.shopify;
    const bulk = options.bulk ?? this.random.chance(1 / 25);
    const payment = options.payment ?? this.planPayment();
    const withStoreOnly = options.withStoreOnly ?? (!bulk && this.random.chance(1 / 12));
    const percent = options.discountPercent !== undefined ? options.discountPercent : this.couponPercent();
    const companies = UK_CUSTOMERS.filter((c) => c.company);
    const customer =
      options.customer ?? (bulk ? this.random.pick(companies) : this.random.pick(UK_CUSTOMERS));
    const customerIndex = UK_CUSTOMERS.indexOf(customer);

    const cart = this.priceCart(this.pickItems(shop.sellables(), withStoreOnly, bulk), percent);
    const shipping = this.random.pick(HILLSIDE_SHIPPING);
    const shipTax = includedVat(shipping.priceMinor, 20);
    const number = shop.nextOrderNumber++;
    const id = ORDER_ID_BASE + number;
    const createdAt = new Date(now.getTime() - this.random.int(3, 30) * 1000);
    const lineTax = sum(cart.map((l) => l.tax));
    const discount = sum(cart.map((l) => l.discount));
    const total = sum(cart.map((l) => l.gross - l.discount)) + shipping.priceMinor;
    const coupon = percent ? this.random.pick(HILLSIDE_COUPONS) : null;
    const address = {
      address1: customer.address,
      address2: null,
      city: customer.city,
      zip: customer.postcode,
      province: customer.region,
      countryCodeV2: 'GB',
      company: customer.company,
      firstName: customer.firstName,
      lastName: customer.lastName,
      phone: customer.phone,
    };

    const transactions: ShopifyTransaction[] = [];
    if (payment === 'paid') transactions.push(this.transaction('SALE', 'shopify_payments', total, now));
    if (payment === 'later')
      transactions.push(this.transaction('AUTHORIZATION', 'shopify_payments', total, now));
    if (payment === 'pending') {
      transactions.push({
        ...this.transaction('SALE', 'Bank Deposit', total, now),
        status: 'PENDING',
        processedAt: null,
      });
    }

    const gql: GqlOrderJson = {
      id: gid('Order', id),
      name: `#${number}`,
      createdAt: shopifyTime(createdAt),
      updatedAt: shopifyTime(now),
      displayFinancialStatus: payment === 'paid' ? 'PAID' : payment === 'later' ? 'AUTHORIZED' : 'PENDING',
      currencyCode: 'GBP',
      taxesIncluded: true,
      note: this.random.chance(0.15) ? this.random.pick(HILLSIDE_NOTES) : null,
      email: customer.email,
      phone: null,
      customer: customer.registered
        ? {
            id: gid('Customer', shopifyCustomerId(customerIndex)),
            firstName: customer.firstName,
            lastName: customer.lastName,
            defaultEmailAddress: { emailAddress: customer.email },
            defaultPhoneNumber: { phoneNumber: customer.phone },
          }
        : null,
      shippingAddress: address,
      billingAddress: address,
      discountCodes: coupon ? [coupon] : [],
      lineItems: {
        nodes: cart.map((line) => ({
          id: gid('LineItem', 15_100_000_000_000 + shop.nextLineId++),
          name: line.item.name,
          sku: line.item.sku || null,
          quantity: line.quantity,
          variant: { id: gid('ProductVariant', line.item.variant.id) },
          product: { id: gid('Product', line.item.product.id) },
          originalUnitPriceSet: money(line.item.priceMinor),
          originalTotalSet: money(line.gross),
          discountAllocations: line.discount ? [{ allocatedAmountSet: money(line.discount) }] : [],
          taxLines:
            line.item.vat === null
              ? []
              : [{ title: 'VAT', ratePercentage: line.item.vat, priceSet: money(line.tax) }],
        })),
      },
      shippingLines: {
        nodes: [
          {
            title: shipping.title,
            isRemoved: false,
            discountedPriceSet: money(shipping.priceMinor),
            taxLines: [{ title: 'VAT', ratePercentage: 20, priceSet: money(shipTax) }],
          },
        ],
      },
      subtotalPriceSet: money(sum(cart.map((l) => l.gross - l.discount))),
      totalDiscountsSet: money(discount),
      totalShippingPriceSet: money(shipping.priceMinor),
      totalPriceSet: money(total),
      totalTaxSet: money(lineTax + shipTax),
      transactions,
    };

    for (const line of cart) shop.reduceStock(line.item, line.quantity);
    const order = shop.addOrder({ id, number, gql });
    const activity = this.state.activity.addOrder({
      shop: 'hillside',
      id: String(id),
      number: `#${number}`,
      customer: `${customer.firstName} ${customer.lastName}${customer.registered ? '' : ' (guest)'}`,
      totalMinor: total,
      currency: 'GBP',
      payment,
      notes: notes(cart, withStoreOnly, percent, bulk),
      createdAt,
      webhook: 'not sent yet',
    });
    return { order, activity };
  }

  markHillsidePaid(order: ShopifyOrder, now = new Date()): void {
    const gql = order.gql;
    const total = Math.round(Number(gql.totalPriceSet.shopMoney.amount) * 100);
    gql.transactions.push(this.transaction('CAPTURE', 'shopify_payments', total, now));
    gql.displayFinancialStatus = 'PAID';
    gql.updatedAt = shopifyTime(now);
  }

  private transaction(
    kind: ShopifyTransaction['kind'],
    gateway: string,
    amount: number,
    at: Date,
  ): ShopifyTransaction {
    return {
      id: gid('OrderTransaction', 7_100_000_000 + this.state.shopify.nextTransactionId++),
      kind,
      status: 'SUCCESS',
      gateway,
      processedAt: shopifyTime(at),
      amountSet: money(amount),
    };
  }

  private couponPercent(): number | null {
    return this.random.chance(0.25) ? this.random.int(5, 15) : null;
  }

  private pickItems<T extends Sellable>(
    all: T[],
    withStoreOnly: boolean,
    bulk: boolean,
  ): Array<{ item: T; quantity: number }> {
    const available = all.filter((i) => !i.storeOnly && (!i.tracked || i.stock > 0));
    const pool = available.length ? available : all.filter((i) => !i.storeOnly);
    if (bulk) {
      const goods = pool.filter((i) => i.tracked);
      const picks = this.random.sample(goods.length ? goods : pool, this.random.int(2, 3));
      const lines = picks.map((item) => ({ item, quantity: this.random.int(12, 30) }));
      // keep doubling until the order is clearly wholesale-sized
      while (lines.length && sum(lines.map((l) => l.item.priceMinor * l.quantity)) < 45_000) {
        for (const line of lines) line.quantity *= 2;
      }
      return lines;
    }
    const roll = this.random.next();
    const count = roll < 0.4 ? 1 : roll < 0.7 ? 2 : roll < 0.9 ? 3 : 4;
    const lines = this.random.sample(pool, count).map((item) => ({ item, quantity: this.quantity(item) }));
    const storeOnly = all.filter((i) => i.storeOnly);
    if (withStoreOnly && storeOnly.length) {
      const extra = { item: this.random.pick(storeOnly), quantity: 1 };
      if (lines.length >= 4) lines[lines.length - 1] = extra;
      else lines.push(extra);
    }
    return lines;
  }

  private quantity(item: Sellable): number {
    const roll = this.random.next();
    const wanted = roll < 0.7 ? 1 : roll < 0.92 ? 2 : 3;
    return item.tracked ? Math.max(1, Math.min(wanted, item.stock)) : 1;
  }

  // prices include VAT in both shops; the coupon is spread over the lines in proportion to their value
  private priceCart<T extends Sellable>(
    picks: Array<{ item: T; quantity: number }>,
    percent: number | null,
  ): CartLine<T>[] {
    return picks.map(({ item, quantity }) => {
      const gross = item.priceMinor * quantity;
      const discount = percent ? percentOf(gross, percent) : 0;
      return {
        item,
        quantity,
        gross,
        discount,
        tax: includedVat(gross - discount, item.vat),
        subtotalTax: includedVat(gross, item.vat),
      };
    });
  }
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function emptyAddress() {
  return {
    first_name: '',
    last_name: '',
    company: '',
    address_1: '',
    address_2: '',
    city: '',
    state: '',
    postcode: '',
    country: '',
  };
}

function notes(
  cart: Array<CartLine<Sellable>>,
  withStoreOnly: boolean,
  percent: number | null,
  bulk: boolean,
): string[] {
  const out: string[] = [];
  if (percent) out.push(`coupon ${percent}%`);
  if (withStoreOnly && cart.some((l) => l.item.storeOnly)) out.push('store-only item');
  if (bulk) out.push('wholesale');
  return out;
}
