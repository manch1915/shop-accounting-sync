import { createHash } from 'node:crypto';
import type { Customer } from './models.js';

const KEY_FORMAT = /^[\w-]{1,50}$/;

/**
 * "woo-c87" for a registered shopper, "woo-g3f9a..." for a guest (hash of the normalized email or
 * phone). Fits Xero's 50-char ContactNumber and is safe to put into MoySklad filter strings.
 */
export function buildMatchKey(prefix: string, customer: Customer): string {
  if (customer.externalId) return `${prefix}-c${customer.externalId.replace(/[^\w-]/g, '')}`.slice(0, 50);
  const identity = (customer.email?.trim().toLowerCase() || customer.phone?.replace(/\D/g, '') || '').trim();
  const source = identity || `${customer.firstName} ${customer.lastName}`.toLowerCase();
  return `${prefix}-g${createHash('sha256').update(source).digest('hex').slice(0, 20)}`;
}

export function requireMatchKey(customer: Customer): string {
  const key = customer.matchKey;
  if (!key || !KEY_FORMAT.test(key)) throw new Error('Customer matchKey is missing or malformed');
  return key;
}
