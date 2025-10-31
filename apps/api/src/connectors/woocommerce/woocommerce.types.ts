// Subset of the WooCommerce REST API v3 payloads we read and write.

export interface WcAddress {
  first_name: string;
  last_name: string;
  company: string;
  address_1: string;
  address_2: string;
  city: string;
  state: string;
  postcode: string;
  country: string;
  email?: string;
  phone?: string;
}

export interface WcTaxRef {
  id: number;
  total: string;
  subtotal: string;
}

export interface WcLineItem {
  id: number;
  name: string;
  product_id: number;
  variation_id: number;
  quantity: number;
  subtotal: string;
  subtotal_tax: string;
  total: string;
  total_tax: string;
  taxes: WcTaxRef[];
  sku: string | null;
}

export interface WcTaxLine {
  id: number;
  rate_id: number;
  rate_code: string;
  label: string;
  rate_percent: number;
  tax_total: string;
  shipping_tax_total: string;
}

export interface WcShippingLine {
  id: number;
  method_title: string;
  method_id: string;
  total: string;
  total_tax: string;
  taxes: WcTaxRef[];
}

export interface WcOrder {
  id: number;
  number: string;
  status: string;
  currency: string;
  prices_include_tax: boolean;
  date_created_gmt: string;
  date_modified_gmt: string;
  date_paid_gmt: string | null;
  discount_total: string;
  shipping_total: string;
  total: string;
  total_tax: string;
  customer_id: number;
  customer_note: string;
  billing: WcAddress;
  shipping: WcAddress;
  payment_method: string;
  payment_method_title: string;
  transaction_id: string;
  line_items: WcLineItem[];
  tax_lines: WcTaxLine[];
  shipping_lines: WcShippingLine[];
}

export interface WcProduct {
  id: number;
  name: string;
  type: 'simple' | 'variable' | 'grouped' | 'external';
  status: string;
  sku: string;
  global_unique_id?: string;
  regular_price: string;
  price: string;
  manage_stock: boolean;
  stock_quantity: number | null;
  variations: number[];
}

export interface WcVariation {
  id: number;
  sku: string;
  global_unique_id?: string;
  regular_price: string;
  price: string;
  manage_stock: boolean | 'parent';
  stock_quantity: number | null;
  attributes: Array<{ name: string; option: string }>;
}

export interface WcBatchResponse {
  update?: Array<{ id: number; error?: { code: string; message: string } }>;
}

export interface WcError {
  code: string;
  message: string;
  data?: { status: number };
}
