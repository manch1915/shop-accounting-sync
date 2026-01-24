'use client';

export class ActionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new ActionError(res.status, data?.message ?? `HTTP ${res.status}`);
  }
  return (await res.json().catch(() => ({}))) as T;
}

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new ActionError(res.status, `HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function setPreference(name: 'sas_locale' | 'sas_theme', value: string): void {
  // biome-ignore lint/suspicious/noDocumentCookie: a one-year preference cookie, no store needed
  document.cookie = `${name}=${value}; path=/; max-age=31536000; samesite=lax`;
}
