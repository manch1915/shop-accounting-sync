import type { ConflictDto } from '@sas/shared';
import clsx from 'clsx';
import { GitCompareArrows } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { EmptyState, PageHeader } from '@/components/ui';
import { relative } from '@/lib/format';
import { api, getDictionary, getLocale } from '@/lib/server';
import { ConflictCard } from './conflict-card';

export const metadata: Metadata = { title: 'Conflicts' };

export default async function ConflictsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const resolved = status === 'resolved';
  const [t, locale, conflicts] = await Promise.all([
    getDictionary(),
    getLocale(),
    api<ConflictDto[]>(`/api/conflicts?status=${resolved ? 'resolved' : 'open'}`),
  ]);

  return (
    <>
      <PageHeader
        title={t.conflicts.title}
        lead={t.conflicts.lead}
        actions={
          <nav
            className="flex rounded-md border border-rule-strong p-0.5 text-sm"
            aria-label={t.conflicts.title}
          >
            {[
              ['', t.conflicts.openTab],
              ['resolved', t.conflicts.resolvedTab],
            ].map(([value, label]) => (
              <Link
                key={value}
                href={value ? `/conflicts?status=${value}` : '/conflicts'}
                aria-current={(value === 'resolved') === resolved ? 'page' : undefined}
                className={clsx(
                  'rounded px-3 py-1',
                  (value === 'resolved') === resolved ? 'bg-sunken font-medium' : 'text-muted hover:text-ink',
                )}
              >
                {label}
              </Link>
            ))}
          </nav>
        }
      />

      {conflicts.length === 0 ? (
        <div className="rounded-lg border border-rule bg-surface">
          <EmptyState
            icon={<GitCompareArrows className="size-8" aria-hidden />}
            title={t.conflicts.empty}
            hint={t.conflicts.emptyHint}
          />
        </div>
      ) : resolved ? (
        <ul className="divide-y divide-rule rounded-lg border border-rule bg-surface">
          {conflicts.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
              <span className="text-muted">{t.conflicts.kinds[c.kind]}</span>
              <span className="font-medium">{c.details.name ?? c.key}</span>
              <span className="text-muted">{c.integrationName}</span>
              <span className="ml-auto text-xs text-muted">{relative(c.createdAt, locale)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="space-y-3">
          {conflicts.map((c) => (
            <ConflictCard key={c.id} conflict={c} locale={locale} />
          ))}
        </div>
      )}
    </>
  );
}
