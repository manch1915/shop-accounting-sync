import { describe, expect, it } from 'vitest';
import { clientKey } from './client-key.js';

describe('clientKey', () => {
  it('keeps IPv4 as is and unwraps IPv4-mapped addresses', () => {
    expect(clientKey('203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey('::FFFF:cb00:7107')).toBe('203.0.113.7');
  });

  it('gives every spelling of one /64 the same key', () => {
    const keys = new Set(
      [
        '2001:db8:0:1::5',
        '2001:0db8:0000:0001:0000:0000:0000:0005',
        '2001:DB8:0:1:ffff::1',
        '2001:db8::1:aaaa:bbbb:cccc:dddd',
        '2001:db8:0:1::9%eth0',
      ].map(clientKey),
    );
    expect([...keys]).toEqual(['2001:db8:0:1::/64']);
  });

  it('separates different prefixes', () => {
    expect(clientKey('2001:db8:0:2::1')).not.toBe(clientKey('2001:db8:0:1::1'));
  });
});
