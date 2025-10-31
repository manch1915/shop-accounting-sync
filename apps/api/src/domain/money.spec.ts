import { describe, expect, it } from 'vitest';
import { fromMinor, toMinor } from './money.js';

describe('money', () => {
  it('converts decimal strings and floats without drift', () => {
    expect(toMinor('12.50', 'GBP')).toBe(1250);
    expect(toMinor(0.1 + 0.2, 'GBP')).toBe(30);
    expect(toMinor('1.005', 'RUB')).toBe(101);
    expect(toMinor('-4.99', 'USD')).toBe(-499);
  });

  it('respects zero-decimal currencies', () => {
    expect(toMinor('1500', 'JPY')).toBe(1500);
    expect(fromMinor(1500, 'JPY')).toBe('1500');
  });

  it('treats empty values as zero', () => {
    expect(toMinor('', 'RUB')).toBe(0);
    expect(toMinor(null, 'RUB')).toBe(0);
  });
});
