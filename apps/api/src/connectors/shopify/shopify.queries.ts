const MONEY = 'shopMoney { amount }';
const TAX_LINES = `taxLines { ratePercentage priceSet { ${MONEY} } }`;
const ADDRESS = 'address1 address2 city zip province countryCodeV2 company firstName lastName phone';

const ORDER_FIELDS = `
  fragment OrderFields on Order {
    id
    name
    createdAt
    updatedAt
    displayFinancialStatus
    currencyCode
    taxesIncluded
    note
    email
    phone
    customer {
      id
      firstName
      lastName
      defaultEmailAddress { emailAddress }
      defaultPhoneNumber { phoneNumber }
    }
    shippingAddress { ${ADDRESS} }
    billingAddress { ${ADDRESS} }
    lineItems(first: 50) {
      nodes {
        id
        name
        sku
        quantity
        variant { id }
        product { id }
        originalUnitPriceSet { ${MONEY} }
        originalTotalSet { ${MONEY} }
        discountAllocations { allocatedAmountSet { ${MONEY} } }
        ${TAX_LINES}
      }
    }
    shippingLines(first: 5) {
      nodes {
        title
        isRemoved
        discountedPriceSet { ${MONEY} }
        ${TAX_LINES}
      }
    }
    totalPriceSet { ${MONEY} }
    totalTaxSet { ${MONEY} }
    transactions(first: 10) { id kind status gateway processedAt }
  }
`;

export const ORDER_QUERY = `
  query Order($id: ID!) {
    order(id: $id) { ...OrderFields }
  }
  ${ORDER_FIELDS}
`;

// ids only: the full order fragment costs ~650 points, so a page of full orders would exceed
// Shopify's 1000-point limit for a single query
export const ORDER_IDS_QUERY = `
  query OrdersUpdatedSince($first: Int!, $query: String!) {
    orders(first: $first, sortKey: UPDATED_AT, query: $query) {
      nodes { id }
    }
  }
`;

export const VARIANTS_QUERY = `
  query Variants($first: Int!, $after: String) {
    productVariants(first: $first, after: $after) {
      nodes {
        id
        title
        sku
        price
        inventoryQuantity
        barcodes(first: 1) { nodes { value } }
        product { id title }
        inventoryItem { id tracked }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const INVENTORY_SET_MUTATION = `
  mutation InventorySet($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      userErrors { field message }
    }
  }
`;

export const VARIANTS_BULK_UPDATE_MUTATION = `
  mutation VariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: true) {
      userErrors { field message }
    }
  }
`;

export const PRODUCT_CREATE_MUTATION = `
  mutation ProductCreate($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product {
        id
        variants(first: 1) { nodes { id inventoryItem { id } } }
      }
      userErrors { field message }
    }
  }
`;
