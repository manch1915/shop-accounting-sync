import { createHash } from 'node:crypto';
import type {
  AccountingConnector,
  AccountingConnectorFactory,
  ConnectorContext,
} from '../../domain/connectors.js';
import type {
  Address,
  CatalogProduct,
  Customer,
  DocumentRef,
  IncomingWebhook,
  NamedRef,
  PaymentInput,
  SalesDocumentInput,
  StockLevel,
  TaxRate,
  WebhookEvent,
  WebhookTopic,
} from '../../domain/models.js';
import { safeEqual } from '../../security/hmac.js';
import type { ErrorPolicy } from '../http/http-client.js';
import type {
  MsCustomerOrderMetadata,
  MsEntity,
  MsError,
  MsList,
  MsMetaRef,
  MsProduct,
  MsStockRow,
  MsStockWebhookBody,
  MsTaxRate,
  MsWebhookBody,
} from './moysklad.types.js';

const PAGE_SIZE = 1000;
const DELIVERY_SERVICE_NAME = 'Доставка';
const NO_VAT_CODE = 'none';
const BARCODE_KEYS = ['ean13', 'ean8', 'code128', 'gtin', 'upc'] as const;

export const moySkladErrorPolicy: ErrorPolicy = {
  retryAfterMs: (headers) => {
    const ms = Number(headers.get('x-lognex-retry-after') ?? headers.get('x-lognex-retry-timeinterval'));
    return Number.isFinite(ms) && ms > 0 ? ms : 3000;
  },
  extractMessage: (body) => {
    try {
      const { errors } = JSON.parse(body) as MsError;
      const text = (errors ?? []).map((e) => (e.code ? `${e.error} (${e.code})` : e.error)).join('; ');
      return text || null;
    } catch {
      return null;
    }
  },
};

const PRODUCT_TOPICS: Record<string, WebhookTopic> = {
  CREATE: 'product.created',
  UPDATE: 'product.updated',
};

export class MoySkladConnector implements AccountingConnector {
  readonly provider = 'moysklad' as const;
  private deliveryServiceId: string | null;

  constructor(private readonly ctx: ConnectorContext) {
    const { token } = ctx.credentials;
    if (!token) throw new Error('MoySklad needs a token');
    ctx.http.setHeader('authorization', `Bearer ${token}`);
    // without gzip MoySklad answers 415 with an empty body
    ctx.http.setHeader('accept-encoding', 'gzip');
    ctx.http.setHeader('accept', 'application/json;charset=utf-8');
    this.deliveryServiceId = this.setting('deliveryServiceId');
  }

  // MoySklad does not sign webhooks, so the delivery URL carries a secret in the query string
  verifyWebhook(webhook: IncomingWebhook, secret: string): boolean {
    return safeEqual(webhook.query?.secret, secret);
  }

  parseWebhook(webhook: IncomingWebhook): WebhookEvent[] {
    const requestId = webhook.query?.requestId ?? digest(webhook.rawBody);
    const body = JSON.parse(webhook.rawBody.toString('utf8')) as MsWebhookBody & Partial<MsStockWebhookBody>;
    if (body.reportUrl && body.stockType) {
      return [{ topic: 'stock.changed', deliveryId: requestId, entityId: null }];
    }
    const out: WebhookEvent[] = [];
    for (const [index, event] of (body.events ?? []).entries()) {
      const topic = event.meta.type === 'product' ? PRODUCT_TOPICS[event.action] : undefined;
      if (!topic) continue;
      out.push({ topic, deliveryId: `${requestId}:${index}`, entityId: lastSegment(event.meta.href) });
    }
    return out;
  }

  async upsertCustomer(customer: Customer): Promise<string> {
    const lookups: Array<[string, string | null]> = [
      ['email', customer.email],
      ['phone', customer.phone],
    ];
    for (const [field, value] of lookups) {
      if (!value) continue;
      const { data } = await this.ctx.http.get<MsList<MsEntity>>('/entity/counterparty', {
        query: { filter: `${field}=${value}`, limit: 1 },
      });
      const found = data.rows[0];
      if (found) return found.id;
    }

    const fullName = `${customer.firstName} ${customer.lastName}`.trim();
    const { data } = await this.ctx.http.post<MsEntity>('/entity/counterparty', {
      json: {
        name: customer.company ?? (fullName || customer.email || customer.phone || 'Покупатель'),
        email: customer.email ?? undefined,
        phone: customer.phone ?? undefined,
        actualAddress: customer.address ? formatAddress(customer.address) : undefined,
        companyType: customer.company ? 'legal' : 'individual',
      },
    });
    return data.id;
  }

  async findSalesDocument(externalRef: string): Promise<DocumentRef | null> {
    const { data } = await this.ctx.http.get<MsList<MsEntity>>('/entity/customerorder', {
      query: { filter: `externalCode=${externalRef}`, limit: 1 },
    });
    const order = data.rows[0];
    return order ? this.documentRef('customerorder', order) : null;
  }

  async createSalesDocument(input: SalesDocumentInput): Promise<DocumentRef> {
    const positions = input.lines.map((line) => ({
      quantity: line.quantity,
      price: line.unitPriceMinor,
      discount: line.discountPercent,
      ...vatFields(line.taxCode === NO_VAT_CODE ? null : line.taxRatePercent),
      assortment: this.meta('product', line.accountingProductId),
    }));
    // a free delivery line would only clutter the document
    if (input.shipping && input.shipping.priceMinor > 0) {
      const { shipping } = input;
      positions.push({
        quantity: 1,
        price: shipping.priceMinor,
        discount: 0,
        ...vatFields(shipping.taxCode === NO_VAT_CODE ? null : shipping.taxRatePercent),
        assortment: this.meta('service', await this.deliveryService()),
      });
    }

    const { data } = await this.ctx.http.post<MsEntity>('/entity/customerorder', {
      json: {
        name: input.number,
        externalCode: input.externalRef,
        moment: this.moment(input.date),
        organization: this.meta('organization', this.organizationId),
        agent: this.meta('counterparty', input.customerId),
        store: input.warehouseId ? this.meta('store', input.warehouseId) : undefined,
        state: input.statusId
          ? this.meta('state', input.statusId, 'customerorder/metadata/states')
          : undefined,
        description: input.comment ?? undefined,
        vatEnabled: true,
        vatIncluded: input.pricesIncludeTax,
        positions,
      },
    });
    return this.documentRef('customerorder', data);
  }

  async registerPayment(input: PaymentInput): Promise<DocumentRef> {
    const { data } = await this.ctx.http.post<MsEntity>('/entity/paymentin', {
      json: {
        organization: this.meta('organization', this.organizationId),
        agent: this.meta('counterparty', input.customerId),
        sum: input.amountMinor,
        moment: this.moment(input.paidAt),
        paymentPurpose: input.reference,
        operations: [
          { ...this.meta('customerorder', input.document.externalId), linkedSum: input.amountMinor },
        ],
      },
    });
    return this.documentRef('paymentin', data);
  }

  async listProducts(): Promise<CatalogProduct[]> {
    const priceTypeName = this.setting('priceTypeName') ?? 'Цена продажи';
    const products = await this.paginate<MsProduct>('/entity/product');
    return products.map((p) => {
      const prices = p.salePrices ?? [];
      const price = prices.find((sp) => sp.priceType.name === priceTypeName) ?? prices[0];
      const vatEnabled = p.effectiveVatEnabled ?? p.vatEnabled ?? false;
      return {
        externalId: p.id,
        sku: p.article || p.code || null,
        barcodes: (p.barcodes ?? []).flatMap((b) => BARCODE_KEYS.map((k) => b[k]).filter(isString)),
        name: p.name,
        priceMinor: price ? Math.round(price.value) : null,
        vatRatePercent: vatEnabled ? (p.effectiveVat ?? p.vat ?? 0) : null,
        archived: p.archived,
      };
    });
  }

  async getStock(warehouseId: string | null): Promise<StockLevel[]> {
    const path = warehouseId ? '/report/stock/bystore/current' : '/report/stock/all/current';
    const { data } = await this.ctx.http.get<MsStockRow[]>(path, {
      query: {
        stockType: 'quantity',
        include: 'zeroLines',
        filter: warehouseId ? `storeId=${warehouseId}` : undefined,
      },
    });
    return data
      .filter((row) => row.quantity !== null)
      .map((row) => ({
        productExternalId: row.assortmentId,
        // weighed goods come as fractions; shops take whole units, so round down to never oversell
        available: Math.max(0, Math.floor(row.quantity ?? 0)),
      }));
  }

  async listWarehouses(): Promise<NamedRef[]> {
    const stores = await this.paginate<MsEntity>('/entity/store');
    return stores.map((s) => ({ externalId: s.id, name: s.name }));
  }

  async listOrderStatuses(): Promise<NamedRef[]> {
    const { data } = await this.ctx.http.get<MsCustomerOrderMetadata>('/entity/customerorder/metadata');
    return (data.states ?? []).map((s) => ({ externalId: s.id, name: s.name }));
  }

  async listTaxRates(): Promise<TaxRate[]> {
    const rates = await this.paginate<MsTaxRate>('/entity/taxrate');
    return [
      ...rates
        .filter((r) => !r.archived)
        .map((r) => ({ code: String(r.rate), name: r.comment || `НДС ${r.rate}%`, ratePercent: r.rate })),
      // "без НДС" is not a rate in the dictionary, it is vat=0 with vatEnabled=false on a position
      { code: NO_VAT_CODE, name: 'Без НДС', ratePercent: 0 },
    ];
  }

  private get base(): string {
    return this.ctx.baseUrl.replace(/\/+$/, '');
  }

  private get organizationId(): string {
    const id = this.setting('organizationId');
    if (!id) throw new Error('MoySklad needs settings.organizationId to create documents');
    return id;
  }

  private setting(key: string): string | null {
    const value = this.ctx.settings[key];
    return typeof value === 'string' && value ? value : null;
  }

  private meta(type: string, id: string, path: string = type): MsMetaRef {
    return { meta: { href: `${this.base}/entity/${path}/${id}`, type, mediaType: 'application/json' } };
  }

  private documentRef(type: 'customerorder' | 'paymentin', entity: MsEntity): DocumentRef {
    const ui = (this.setting('uiUrl') ?? 'https://online.moysklad.ru/app').replace(/\/+$/, '');
    return { externalId: entity.id, number: entity.name, url: `${ui}/#${type}/edit?id=${entity.id}` };
  }

  private moment(date: Date): string {
    return formatMoment(date, this.setting('timezone') ?? 'Europe/Moscow');
  }

  private async deliveryService(): Promise<string> {
    if (this.deliveryServiceId) return this.deliveryServiceId;
    const { data } = await this.ctx.http.get<MsList<MsEntity>>('/entity/service', {
      query: { filter: `name=${DELIVERY_SERVICE_NAME}`, limit: 1 },
    });
    const existing = data.rows[0];
    const id = existing
      ? existing.id
      : (await this.ctx.http.post<MsEntity>('/entity/service', { json: { name: DELIVERY_SERVICE_NAME } }))
          .data.id;
    this.deliveryServiceId = id;
    return id;
  }

  private async paginate<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data } = await this.ctx.http.get<MsList<T>>(path, { query: { limit: PAGE_SIZE, offset } });
      out.push(...data.rows);
      if (data.rows.length === 0 || offset + data.rows.length >= data.meta.size) return out;
    }
  }
}

function vatFields(rate: number | null): { vat: number; vatEnabled: boolean } {
  return { vat: rate ?? 0, vatEnabled: rate !== null };
}

function formatAddress(a: Address): string {
  return [a.postcode, a.country, a.region, a.city, a.line1, a.line2].filter(Boolean).join(', ');
}

// MoySklad wants local wall-clock time "YYYY-MM-DD HH:mm:ss" without an offset
function formatMoment(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function lastSegment(href: string): string | null {
  return new URL(href).pathname.split('/').filter(Boolean).pop() ?? null;
}

function digest(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 32);
}

function isString(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

export const moySkladFactory: AccountingConnectorFactory = {
  provider: 'moysklad',
  kind: 'accounting',
  create: (ctx) => new MoySkladConnector(ctx),
};
