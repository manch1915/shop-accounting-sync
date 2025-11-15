// Subset of the Shopify Admin GraphQL 2026-10 payloads we read and write.

export interface GqlError {
  message: string;
  extensions?: { code?: string };
}

export interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

export interface GqlResponse<T> {
  data?: T | null;
  /** an array for GraphQL errors, a plain string for auth failures on 401/403 */
  errors?: GqlError[] | string;
  extensions?: {
    cost?: {
      requestedQueryCost: number;
      actualQueryCost: number | null;
      throttleStatus: ThrottleStatus;
    };
  };
}

export interface UserError {
  field: string[] | null;
  message: string;
}

export interface MoneyBag {
  shopMoney: { amount: string };
}

export interface GqlTaxLine {
  ratePercentage: number | null;
  priceSet: MoneyBag;
}

export interface GqlAddress {
  address1: string | null;
  address2: string | null;
  city: string | null;
  zip: string | null;
  province: string | null;
  countryCodeV2: string | null;
  company: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
}

export interface GqlLineItem {
  id: string;
  name: string;
  sku: string | null;
  quantity: number;
  variant: { id: string } | null;
  product: { id: string } | null;
  originalUnitPriceSet: MoneyBag;
  originalTotalSet: MoneyBag;
  discountAllocations: Array<{ allocatedAmountSet: MoneyBag }>;
  taxLines: GqlTaxLine[];
}

export interface GqlShippingLine {
  title: string;
  isRemoved: boolean;
  discountedPriceSet: MoneyBag;
  taxLines: GqlTaxLine[];
}

export interface GqlTransaction {
  id: string;
  kind: string;
  status: string;
  gateway: string | null;
  processedAt: string | null;
}

export interface GqlOrder {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  displayFinancialStatus: string | null;
  currencyCode: string;
  taxesIncluded: boolean;
  note: string | null;
  email: string | null;
  phone: string | null;
  customer: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    defaultEmailAddress: { emailAddress: string } | null;
    defaultPhoneNumber: { phoneNumber: string } | null;
  } | null;
  shippingAddress: GqlAddress | null;
  billingAddress: GqlAddress | null;
  lineItems: { nodes: GqlLineItem[] };
  shippingLines: { nodes: GqlShippingLine[] };
  totalPriceSet: MoneyBag;
  totalTaxSet: MoneyBag | null;
  transactions: GqlTransaction[];
}

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface GqlVariant {
  id: string;
  title: string;
  sku: string | null;
  price: string;
  inventoryQuantity: number | null;
  barcodes: { nodes: Array<{ value: string }> };
  product: { id: string; title: string };
  inventoryItem: { id: string; tracked: boolean };
}

export interface OrderQuery {
  order: GqlOrder | null;
}

export interface OrderIdsQuery {
  orders: { nodes: Array<{ id: string }> };
}

export interface VariantsQuery {
  productVariants: { nodes: GqlVariant[]; pageInfo: PageInfo };
}

export interface InventorySetMutation {
  inventorySetQuantities: { userErrors: UserError[] };
}

export interface VariantsBulkUpdateMutation {
  productVariantsBulkUpdate: { userErrors: UserError[] };
}

export interface ProductCreateMutation {
  productCreate: {
    product: {
      id: string;
      variants: { nodes: Array<{ id: string; inventoryItem: { id: string } }> };
    } | null;
    userErrors: UserError[];
  };
}

export interface ShopifyWebhookBody {
  id?: number;
}
