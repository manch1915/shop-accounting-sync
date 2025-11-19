// Subset of the MoySklad JSON API 1.2 payloads we read and write.

export interface MsMeta {
  href: string;
  type: string;
  mediaType: 'application/json';
}

export interface MsMetaRef {
  meta: MsMeta;
}

export interface MsList<T> {
  meta: { href: string; size: number; limit: number; offset: number };
  rows: T[];
}

export interface MsEntity {
  id: string;
  name: string;
}

export interface MsBarcode {
  ean13?: string;
  ean8?: string;
  code128?: string;
  gtin?: string;
  upc?: string;
}

export interface MsSalePrice {
  /** kopecks, sent as a float */
  value: number;
  priceType: { id: string; name: string };
}

export interface MsProduct extends MsEntity {
  code?: string;
  article?: string;
  archived: boolean;
  barcodes?: MsBarcode[];
  salePrices?: MsSalePrice[];
  vat?: number;
  vatEnabled?: boolean;
  /** resolved rate when the product inherits VAT from its group */
  effectiveVat?: number;
  effectiveVatEnabled?: boolean;
}

export interface MsStockRow {
  assortmentId: string;
  storeId?: string | null;
  quantity: number | null;
}

export interface MsTaxRate {
  id: string;
  rate: number;
  comment?: string;
  archived?: boolean;
}

export interface MsCustomerOrderMetadata {
  states?: Array<{ id: string; name: string }>;
}

export interface MsError {
  errors?: Array<{ error: string; code?: number; moreInfo?: string }>;
}

export interface MsWebhookBody {
  auditContext?: { moment?: string; uid?: string };
  events?: Array<{ meta: { type: string; href: string }; action: string }>;
}

export interface MsStockWebhookBody {
  accountId: string;
  stockType: string;
  reportType: string;
  reportUrl: string;
}
