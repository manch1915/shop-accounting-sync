import type { Locale } from './i18n';

const tag = (locale: Locale) => (locale === 'ru' ? 'ru-RU' : 'en-GB');

export function money(minor: number, currency: string, locale: Locale): string {
  return new Intl.NumberFormat(tag(locale), {
    style: 'currency',
    currency,
    maximumFractionDigits: currency === 'RUB' ? 0 : 2,
  }).format(minor / 100);
}

export function count(value: number, locale: Locale): string {
  return new Intl.NumberFormat(tag(locale)).format(value);
}

export function percent(value: number, locale: Locale): string {
  return new Intl.NumberFormat(tag(locale), { style: 'percent', maximumFractionDigits: 1 }).format(value);
}

/** 840 ms, 2.4 s, 1 min 12 s */
export function duration(ms: number | null, locale: Locale): string {
  if (ms === null) return '—';
  const ru = locale === 'ru';
  if (ms < 1000) return `${Math.round(ms)} ${ru ? 'мс' : 'ms'}`;
  if (ms < 60_000) {
    const s = ms / 1000;
    return `${s < 10 ? s.toFixed(1) : Math.round(s)} ${ru ? 'с' : 's'}`;
  }
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return ru ? `${min} мин ${sec} с` : `${min} min ${sec} s`;
}

export function relative(iso: string, locale: Locale, now = Date.now()): string {
  const diff = (new Date(iso).getTime() - now) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(tag(locale), { numeric: 'auto' });
  if (abs < 45) return rtf.format(Math.round(diff), 'second');
  if (abs < 2700) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 79_200) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86_400), 'day');
}

export function dateTime(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(tag(locale), {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(iso));
}

export function shortDate(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(tag(locale), { day: 'numeric', month: 'short' }).format(new Date(iso));
}
