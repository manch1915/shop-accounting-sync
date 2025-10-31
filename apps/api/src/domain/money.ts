const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'UGX', 'XAF', 'XOF']);

export function currencyExponent(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

/** "12.50" | 12.5 -> 1250. Rounds half away from zero, like most shop engines. */
export function toMinor(value: string | number | null | undefined, currency: string): number {
  if (value === null || value === undefined || value === '') return 0;
  // work on the decimal string, floats turn 1.005 into 1.00499999
  const text = typeof value === 'number' ? Number(value.toPrecision(15)).toString() : value.trim();
  const match = /^(-)?(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (!match[2] && !match[3])) throw new Error(`Not a money amount: ${value}`);
  const [, sign, whole = '', fraction = ''] = match;
  const exp = currencyExponent(currency);
  const digits = fraction.padEnd(exp + 1, '0');
  let minor = Number(whole || '0') * 10 ** exp + Number(digits.slice(0, exp) || '0');
  if (Number(digits[exp]) >= 5) minor += 1;
  return sign && minor !== 0 ? -minor : minor;
}

/** 1250 -> "12.50" */
export function fromMinor(minor: number, currency: string): string {
  const exp = currencyExponent(currency);
  return (minor / 10 ** exp).toFixed(exp);
}

/** 1250 -> 12.5, for APIs that take JSON numbers */
export function minorToNumber(minor: number, currency: string): number {
  return Number(fromMinor(minor, currency));
}

export function percentOf(part: number, whole: number): number {
  if (whole === 0) return 0;
  return Math.round((part / whole) * 10_000) / 100;
}
