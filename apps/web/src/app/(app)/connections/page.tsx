import type { ConnectionDto, IntegrationFlags } from '@sas/shared';
import clsx from 'clsx';
import { KeyRound, Lock } from 'lucide-react';
import type { Metadata } from 'next';
import { RunNowButton } from '@/components/actions';
import { PROVIDER_NAMES, ProviderMark } from '@/components/provider-mark';
import { PageHeader } from '@/components/ui';
import { relative } from '@/lib/format';
import type { Dictionary, Locale } from '@/lib/i18n';
import { getIntegrations } from '@/lib/routes';
import { getDictionary, getLocale, getSession } from '@/lib/server';

export const metadata: Metadata = { title: 'Connections' };

const STATUS_TONE: Record<ConnectionDto['status'], string> = {
  active: 'text-ok',
  degraded: 'text-warn',
  error: 'text-bad',
  disconnected: 'text-muted',
};

export default async function ConnectionsPage() {
  const [t, locale, integrations, session] = await Promise.all([
    getDictionary(),
    getLocale(),
    getIntegrations(),
    getSession(),
  ]);
  const runnable = [
    ['orders.reconcile', t.types['orders.reconcile']],
    ['stock.push', t.types['stock.push']],
    ['price.push', t.types['price.push']],
    ['catalog.refresh', t.types['catalog.refresh']],
  ] as const;

  return (
    <>
      <PageHeader title={t.connections.title} lead={t.connections.lead} />
      <div className="space-y-6">
        {integrations.map((i) => (
          <section key={i.id} className="rounded-lg border border-rule bg-surface">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-4 py-3">
              <h2 className="font-semibold">{i.name}</h2>
              {session.canAct && (
                <div className="flex flex-wrap gap-2">
                  {runnable.map(([type, label]) => (
                    <RunNowButton key={type} integrationId={i.id} type={type} locale={locale} label={label} />
                  ))}
                </div>
              )}
            </header>
            <div className="grid md:grid-cols-[1fr_auto_1fr]">
              <ConnectionCard connection={i.store} t={t} locale={locale} />
              <div className="hidden items-center md:flex">
                <span
                  className="route-line w-16"
                  data-state={
                    i.store.status === 'active' && i.accounting.status === 'active' ? 'succeeded' : 'retrying'
                  }
                />
              </div>
              <ConnectionCard
                connection={i.accounting}
                t={t}
                locale={locale}
                className="border-t border-rule md:border-t-0"
              />
            </div>
            <div className="border-t border-rule px-4 py-3">
              <h3 className="mb-2 text-sm text-muted">{t.connections.flows}</h3>
              <ul className="flex flex-wrap gap-2">
                {(Object.keys(t.connections.flags) as Array<keyof IntegrationFlags>).map((flag) => {
                  const on = i.flags[flag];
                  return (
                    <li
                      key={flag}
                      className={clsx(
                        'inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-sm',
                        on ? 'border-ok/40 text-ink' : 'border-rule text-muted',
                      )}
                    >
                      <span
                        aria-hidden
                        className={clsx('size-2 rounded-full', on ? 'bg-ok' : 'border border-faint')}
                      />
                      {t.connections.flags[flag]}
                      <span className="sr-only">{on ? t.connections.on : t.connections.off}</span>
                    </li>
                  );
                })}
                {session.demo && (
                  <li className="inline-flex items-center gap-1.5 px-1 text-xs text-muted">
                    <Lock className="size-3.5" aria-hidden />
                    {t.connections.lockedInDemo}
                  </li>
                )}
              </ul>
            </div>
          </section>
        ))}
      </div>
    </>
  );
}

function ConnectionCard({
  connection: c,
  t,
  locale,
  className,
}: {
  connection: ConnectionDto;
  t: Dictionary;
  locale: Locale;
  className?: string;
}) {
  const usage = c.rateLimit ? Math.min(1, c.rateLimit.used / c.rateLimit.limit) : 0;
  return (
    <div className={clsx('p-4', className)}>
      <div className="flex items-center gap-2.5">
        <ProviderMark provider={c.provider} size="md" />
        <div className="min-w-0">
          <p className="font-medium">{PROVIDER_NAMES[c.provider]}</p>
          <p className="truncate text-xs text-muted">{c.name}</p>
        </div>
        <span className={clsx('ml-auto text-sm font-medium', STATUS_TONE[c.status])}>
          {t.connections.status[c.status]}
        </span>
      </div>
      {c.statusReason && <p className="mt-2 text-sm text-bad">{c.statusReason}</p>}
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted">
          <KeyRound className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />
          {t.connections.auth[c.authType]}
        </dt>
        <dd className="truncate font-mono text-xs leading-5 text-muted">{new URL(c.baseUrl).host}</dd>
        <dt className="text-muted">{t.connections.lastSync}</dt>
        <dd>{c.lastSyncAt ? relative(c.lastSyncAt, locale) : t.overview.never}</dd>
        {c.tokenExpiresAt && (
          <>
            <dt className="text-muted">{t.connections.tokenExpires}</dt>
            <dd>{relative(c.tokenExpiresAt, locale)}</dd>
          </>
        )}
        {c.rateLimit && (
          <>
            <dt className="text-muted">{t.connections.rateLimit}</dt>
            <dd className="flex items-center gap-2">
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-sunken">
                <span
                  className={clsx('block h-full rounded-full', usage > 0.8 ? 'bg-warn' : 'bg-accent')}
                  style={{ width: `${Math.max(2, usage * 100)}%` }}
                />
              </span>
              <span className="num text-xs text-muted">
                {c.rateLimit.used}/{c.rateLimit.limit} · {c.rateLimit.windowSec} s
              </span>
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}
