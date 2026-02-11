import type { AlertDto } from '@sas/shared';
import clsx from 'clsx';
import { BellOff, Send } from 'lucide-react';
import type { Metadata } from 'next';
import { EmptyState, PageHeader } from '@/components/ui';
import { dateTime } from '@/lib/format';
import { api, getDictionary, getLocale } from '@/lib/server';

export const metadata: Metadata = { title: 'Alerts' };

export default async function AlertsPage() {
  const [t, locale, alerts] = await Promise.all([
    getDictionary(),
    getLocale(),
    api<AlertDto[]>('/api/alerts'),
  ]);
  return (
    <>
      <PageHeader title={t.alerts.title} lead={t.alerts.lead} />
      <div className="rounded-lg border border-rule bg-surface">
        {alerts.length === 0 ? (
          <EmptyState icon={<BellOff className="size-8" aria-hidden />} title={t.alerts.empty} />
        ) : (
          <ul className="divide-y divide-rule">
            {alerts.map((a) => (
              <li key={a.id} className="grid gap-1 px-4 py-3 sm:grid-cols-[1fr_auto] sm:gap-4">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-medium">
                    <span
                      aria-hidden
                      className={clsx(
                        'size-2 shrink-0',
                        a.severity === 'critical' ? 'rotate-45 bg-bad' : 'rounded-full bg-warn',
                      )}
                    />
                    {a.title}
                  </p>
                  <p className="mt-0.5 text-sm text-pretty text-muted">{a.body}</p>
                </div>
                <div className="text-xs text-muted sm:text-right">
                  <p className="num">{dateTime(a.createdAt, locale)}</p>
                  <p className="mt-0.5 inline-flex items-center gap-1">
                    {a.channel === 'telegram' && <Send className="size-3" aria-hidden />}
                    {a.channel === 'telegram' ? t.alerts.telegram : t.alerts.logOnly}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
