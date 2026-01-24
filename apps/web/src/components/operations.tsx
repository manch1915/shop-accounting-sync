'use client';

import type { OperationDto, Provider } from '@sas/shared';
import clsx from 'clsx';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { errorText } from '@/lib/errors';
import { duration, relative } from '@/lib/format';
import { dictionary, type Locale } from '@/lib/i18n';
import { Route } from './route';
import { StatusBadge } from './ui';

export type RouteMap = Record<string, { store: Provider; accounting: Provider; name: string }>;

/** Re-render relative times every 20 s without refetching anything. */
export function useNow(intervalMs = 20_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** "Order #4127" from the API becomes the localized type plus the number. */
export function OperationSubject({ op, locale }: { op: OperationDto; locale: Locale }) {
  const t = dictionary(locale);
  const number = /#\S+/.exec(op.subject)?.[0];
  return (
    <span className="min-w-0">
      <span className={number ? 'text-muted' : 'font-medium text-ink'}>{t.types[op.type]}</span>
      {number && <span className="num font-medium text-ink"> {number}</span>}
    </span>
  );
}

export function OperationRows({
  items,
  routes,
  locale,
  fresh,
  compact = false,
}: {
  items: OperationDto[];
  routes: RouteMap;
  locale: Locale;
  fresh?: Set<string>;
  compact?: boolean;
}) {
  const now = useNow();
  const t = dictionary(locale);
  return (
    <ul className="divide-y divide-rule">
      {items.map((op) => {
        const route = routes[op.integrationId];
        const error =
          op.errorCode && op.status !== 'succeeded' ? errorText(op.errorCode, op.errorParams, locale) : null;
        return (
          <li key={op.id} className={clsx(fresh?.has(op.id) && 'row-new')}>
            <Link
              href={`/activity/${op.id}`}
              className={clsx(
                'grid items-center gap-x-4 gap-y-1 px-4 py-2.5 hover:bg-sunken focus-visible:bg-sunken',
                compact
                  ? 'grid-cols-[64px_1fr_auto] sm:grid-cols-[72px_minmax(0,1fr)_112px_88px]'
                  : 'grid-cols-[64px_1fr_auto] md:grid-cols-[80px_minmax(0,1.6fr)_minmax(0,1fr)_120px_72px_96px]',
              )}
            >
              {route ? (
                <Route store={route.store} accounting={route.accounting} type={op.type} status={op.status} />
              ) : (
                <span />
              )}
              <span className="flex min-w-0 flex-col">
                <span className="truncate">
                  <OperationSubject op={op} locale={locale} />
                </span>
                <span className={clsx('truncate text-xs', error ? 'text-muted' : 'text-faint')}>
                  {error ? error.title : route?.name}
                </span>
              </span>
              {!compact && <span className="hidden truncate text-sm text-muted md:block">{route?.name}</span>}
              <span className={clsx(compact ? 'hidden sm:block' : 'hidden md:block')}>
                <StatusBadge status={op.status} label={t.status[op.status]} />
              </span>
              {!compact && (
                <span className="num hidden text-sm text-muted md:block">
                  {op.attempts > 1
                    ? `${op.attempts} ${t.common.of} ${op.maxAttempts}`
                    : duration(op.durationMs, locale)}
                </span>
              )}
              <span className="num flex flex-col items-end text-right text-xs text-muted">
                <span className={clsx(compact ? 'sm:hidden' : 'md:hidden')}>
                  <StatusBadge status={op.status} label={t.status[op.status]} />
                </span>
                <time dateTime={op.createdAt}>{relative(op.createdAt, locale, now)}</time>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
