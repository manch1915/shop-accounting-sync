'use client';

import clsx from 'clsx';
import { LogOut, Monitor, Moon, Sun } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { post, setPreference } from '@/lib/client';
import type { Dictionary, Locale } from '@/lib/i18n';
import { useLive } from './live';

export function LiveIndicator({ t }: { t: Dictionary['shell'] }) {
  const state = useLive();
  const open = state === 'open';
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted" role="status">
      <span className={clsx('relative size-2 rounded-full', open ? 'bg-ok' : 'bg-warn')}>
        {open && (
          <span className="absolute inset-0 animate-ping rounded-full bg-ok opacity-40 motion-reduce:hidden" />
        )}
      </span>
      {open ? t.live : t.reconnecting}
    </span>
  );
}

export function Preferences({
  t,
  locale,
  theme,
}: {
  t: Dictionary['shell'];
  locale: Locale;
  theme: 'light' | 'dark' | 'system';
}) {
  const router = useRouter();
  const nextTheme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
  const ThemeIcon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className="h-8 rounded-md px-2 text-xs font-medium text-muted hover:bg-sunken hover:text-ink"
        aria-label={`${locale === 'en' ? 'RU' : 'EN'}, ${t.language}`}
        onClick={() => {
          setPreference('sas_locale', locale === 'en' ? 'ru' : 'en');
          router.refresh();
        }}
      >
        {locale === 'en' ? 'RU' : 'EN'}
      </button>
      <button
        type="button"
        className="grid size-8 place-items-center rounded-md text-muted hover:bg-sunken hover:text-ink"
        aria-label={`${t.theme}: ${theme}`}
        title={`${t.theme}: ${theme}`}
        onClick={() => {
          setPreference('sas_theme', nextTheme);
          if (nextTheme === 'system') document.documentElement.removeAttribute('data-theme');
          else document.documentElement.setAttribute('data-theme', nextTheme);
          router.refresh();
        }}
      >
        <ThemeIcon className="size-4" aria-hidden />
      </button>
    </div>
  );
}

export function SignOut({ label }: { label: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={async () => {
        await post('/api/auth/logout').catch(() => null);
        router.replace('/login');
      }}
      className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-muted hover:bg-sunken hover:text-ink"
    >
      <LogOut className="size-4" aria-hidden />
      <span className="sr-only sm:not-sr-only">{label}</span>
    </button>
  );
}
