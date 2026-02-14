// Everything inside the sandbox is integer minor units; APIs get strings or floats only at the edge.

/** 74900 -> "749.00" */
export function toDecimal(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** 74900 -> 749 (JSON number for Xero) */
export function toNumber(minor: number): number {
  return Number(toDecimal(minor));
}

/** "749.00" | 749 -> 74900 */
export function fromDecimal(value: string | number): number {
  const text = typeof value === 'number' ? value.toFixed(2) : value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return Number.NaN;
  return Math.round(Number(text) * 100);
}

/** VAT contained in a tax-inclusive amount */
export function includedVat(gross: number, ratePercent: number | null): number {
  if (!ratePercent) return 0;
  return Math.round((gross * ratePercent) / (100 + ratePercent));
}

/** VAT on top of a tax-exclusive amount */
export function addedVat(net: number, ratePercent: number | null): number {
  if (!ratePercent) return 0;
  return Math.round((net * ratePercent) / 100);
}

/** pct of an amount, rounded to a minor unit */
export function percentOf(amount: number, percent: number): number {
  return Math.round((amount * percent) / 100);
}
