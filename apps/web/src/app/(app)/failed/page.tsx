import type { ErrorGroupDto } from '@sas/shared';
import { CircleCheck } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { RetryButton } from '@/components/actions';
import { OperationSubject } from '@/components/operations';
import { ProviderLabel } from '@/components/provider-mark';
import { EmptyState, PageHeader } from '@/components/ui';
import { errorText } from '@/lib/errors';
import { relative } from '@/lib/format';
import { api, getDictionary, getLocale } from '@/lib/server';

export const metadata: Metadata = { title: 'Failed jobs' };

export default async function FailedPage() {
  const [t, locale, groups] = await Promise.all([
    getDictionary(),
    getLocale(),
    api<ErrorGroupDto[]>('/api/errors'),
  ]);

  return (
    <>
      <PageHeader title={t.failed.title} lead={t.failed.lead} />
      {groups.length === 0 ? (
        <div className="rounded-lg border border-rule bg-surface">
          <EmptyState
            icon={<CircleCheck className="size-8" aria-hidden />}
            title={t.failed.empty}
            hint={t.failed.emptyHint}
          />
        </div>
      ) : (
        <ul className="space-y-3">
          {groups.map((g) => {
            const text = errorText(g.errorCode, g.params, locale);
            return (
              <li
                key={`${g.errorCode}-${g.sample.id}`}
                className="grid gap-4 rounded-lg border border-rule border-l-4 border-l-bad bg-surface p-4 md:grid-cols-[1fr_auto]"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <h2 className="font-semibold">{text.title}</h2>
                    <span className="num rounded bg-bad-soft px-1.5 text-sm font-medium text-bad">
                      × {g.count}
                    </span>
                  </div>
                  <p className="mt-1 max-w-[80ch] text-pretty text-sm text-muted">{text.hint}</p>
                  {g.sample.errorDetail && (
                    <p className="mt-2 font-mono text-xs break-words text-muted">{g.sample.errorDetail}</p>
                  )}
                  <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
                    <ProviderLabel provider={g.provider} />
                    <span className="text-muted">{g.sample.integrationName}</span>
                    <span className="text-muted">
                      {t.failed.lastSeen} {relative(g.lastSeenAt, locale)}
                    </span>
                    <Link href={`/activity/${g.sample.id}`} className="text-accent hover:underline">
                      {t.failed.example}: <OperationSubject op={g.sample} locale={locale} />
                    </Link>
                  </div>
                </div>
                <div className="md:self-center">
                  <RetryButton ids={g.operationIds} locale={locale} label={t.failed.retryAll(g.count)} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
