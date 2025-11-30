import { describe, expect, it } from 'vitest';
import { buildMatchKey, requireMatchKey } from './customer-key.js';
import type { Customer } from './models.js';

const base: Customer = {
  externalId: null,
  email: 'Guest@Example.com ',
  phone: null,
  firstName: 'Ann',
  lastName: 'Lee',
  company: null,
  address: null,
};

describe('customer match key', () => {
  it('uses the store customer id for registered shoppers', () => {
    expect(buildMatchKey('woo', { ...base, externalId: '87' })).toBe('woo-c87');
  });

  it('hashes the normalized email for guests, so case and spaces do not split one person in two', () => {
    const a = buildMatchKey('woo', base);
    expect(a).toMatch(/^woo-g[0-9a-f]{20}$/);
    expect(buildMatchKey('woo', { ...base, email: 'guest@example.com' })).toBe(a);
    expect(buildMatchKey('shop', base)).not.toBe(a);
  });

  it('only accepts keys that are safe for provider filters', () => {
    expect(requireMatchKey({ ...base, matchKey: 'woo-c87' })).toBe('woo-c87');
    expect(() => requireMatchKey({ ...base, matchKey: 'a;b=c' })).toThrow();
  });
});
