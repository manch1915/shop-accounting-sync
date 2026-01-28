import type { OperationDto, Page } from '@sas/shared';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui';
import { getIntegrations, routeMap } from '@/lib/routes';
import { api, getDictionary, getLocale } from '@/lib/server';
import { type ActivityFilter, ActivityTable } from './activity-table';

export const metadata: Metadata = { title: 'Activity' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ActivityPage({ searchParams }: { searchParams: SearchParams }) {
  const raw = await searchParams;
  const one = (key: string) => (typeof raw[key] === 'string' ? (raw[key] as string) : undefined);
  const filter: ActivityFilter = {
    status: one('status'),
    type: one('type'),
    integrationId: one('integrationId'),
    q: one('q'),
  };
  const query = new URLSearchParams({ limit: '50' });
  for (const [key, value] of Object.entries(filter)) if (value) query.set(key, value);

  const [t, locale, page, integrations] = await Promise.all([
    getDictionary(),
    getLocale(),
    api<Page<OperationDto>>(`/api/operations?${query.toString()}`),
    getIntegrations(),
  ]);

  return (
    <>
      <PageHeader title={t.activity.title} lead={t.activity.lead} />
      <ActivityTable
        // a new filter means a new list; remount instead of merging state
        key={query.toString()}
        initial={page}
        routes={routeMap(integrations)}
        integrations={integrations.map((i) => ({ id: i.id, name: i.name }))}
        filter={filter}
        locale={locale}
      />
    </>
  );
}
