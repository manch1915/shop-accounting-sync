import 'server-only';
import type { SessionDto } from '@sas/shared';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { dictionary, LOCALE_COOKIE, type Locale, pickLocale } from './i18n';

const API = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
export const SESSION_COOKIE = 'sas_session';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Server-side call to the API with the visitor's session cookie. */
export async function api<T>(path: string): Promise<T> {
  const jar = await cookies();
  const session = jar.get(SESSION_COOKIE)?.value;
  const res = await fetch(`${API}${path}`, {
    headers: session ? { cookie: `${SESSION_COOKIE}=${session}` } : {},
    cache: 'no-store',
  });
  if (res.status === 401) redirect('/login');
  if (!res.ok) throw new ApiError(res.status, `${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const getSession = cache(() => api<SessionDto>('/api/auth/session'));

export const getLocale = cache(async (): Promise<Locale> => {
  const [jar, h] = await Promise.all([cookies(), headers()]);
  return pickLocale(jar.get(LOCALE_COOKIE)?.value, h.get('accept-language'));
});

export async function getDictionary() {
  return dictionary(await getLocale());
}

export const getTheme = cache(async (): Promise<'light' | 'dark' | 'system'> => {
  const value = (await cookies()).get('sas_theme')?.value;
  return value === 'light' || value === 'dark' ? value : 'system';
});
