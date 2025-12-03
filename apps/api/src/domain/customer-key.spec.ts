import { describe, expect, it } from 'vitest';
import { buildMatchKey, requireMatchKey } from './customer-key.js';
import type { Customer } from './models.js';

const guest: Customer = {
  externalId: null,
  email: 'guest@example.com',
  phone: null,
  firstName: 'Ann',
  lastName: 'Lee',
  company: null,
  address: null,
};

describe('customer match key', () => {
  it('uses the store customer id for shoppers with an account', () => {
    expect(buildMatchKey('woo', { ...guest, externalId: '87' }, '4127')).toBe('woo-c87');
  });

  it('never reuses a guest contact by checkout fields', () => {
    expect(buildMatchKey('woo', guest, '4127')).toBe('woo-o4127');
    expect(buildMatchKey('woo', guest, '4128')).not.toBe(buildMatchKey('woo', guest, '4127'));
  });

  it('only accepts keys that are safe for provider filters', () => {
    expect(requireMatchKey({ ...guest, matchKey: 'woo-c87' })).toBe('woo-c87');
    expect(() => requireMatchKey({ ...guest, matchKey: 'a;b=c' })).toThrow();
  });
});
