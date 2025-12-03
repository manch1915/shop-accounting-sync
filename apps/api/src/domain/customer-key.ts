import type { Customer } from './models.js';

const KEY_FORMAT = /^[\w-]{1,50}$/;

/**
 * "woo-c87" for a shopper with a store account, "woo-o4127" for a guest order. Guests get one
 * contact per order on purpose: everything in a guest checkout is typed by the shopper, so reusing
 * a contact by email or name would let anyone attach orders to someone else's account.
 * Fits Xero's 50-char ContactNumber and is safe to put into MoySklad filter strings.
 */
export function buildMatchKey(prefix: string, customer: Customer, orderId: string): string {
  const id = customer.externalId ? `c${customer.externalId}` : `o${orderId}`;
  return `${prefix}-${id.replace(/[^\w-]/g, '')}`.slice(0, 50);
}

export function requireMatchKey(customer: Customer): string {
  const key = customer.matchKey;
  if (!key || !KEY_FORMAT.test(key)) throw new Error('Customer matchKey is missing or malformed');
  return key;
}
