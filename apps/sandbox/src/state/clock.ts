/** "2026-10-18T09:14:03" in UTC, the WooCommerce *_gmt format */
export function wpGmt(date: Date): string {
  return date.toISOString().slice(0, 19);
}

/** wall-clock time in a zone, "YYYY-MM-DD HH:mm:ss" */
export function localTime(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** "2026-10-18T12:14:03" in Moscow, the WooCommerce local format for this shop */
export function wpLocal(date: Date): string {
  return localTime(date, 'Europe/Moscow').replace(' ', 'T');
}

/** "2026-10-18 12:14:03.000", how МойСклад prints moments */
export function msMoment(date: Date): string {
  return `${localTime(date, 'Europe/Moscow')}.000`;
}

/** parses a МойСклад moment (Moscow wall-clock time) */
export function parseMsMoment(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  // Moscow has stayed on UTC+3 without DST since 2014
  return new Date(Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 1, (h ?? 0) - 3, mi ?? 0, s ?? 0));
}

/** "/Date(1792195200000+0000)/", the .NET JSON date Xero still returns */
export function xeroDate(date: Date): string {
  return `/Date(${date.getTime()}+0000)/`;
}
