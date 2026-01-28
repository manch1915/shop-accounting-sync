'use client';

import {
  OPERATION_STATUSES,
  OPERATION_TYPES,
  type OperationDto,
  type OperationStatus,
  type Page,
} from '@sas/shared';
import { ListFilter, LoaderCircle, Search } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { useLive } from '@/components/live';
import { OperationRows, type RouteMap } from '@/components/operations';
import { Button, EmptyState, inputClass } from '@/components/ui';
import { get } from '@/lib/client';
import { dictionary, type Locale } from '@/lib/i18n';

export interface ActivityFilter {
  status?: string;
  type?: string;
  integrationId?: string;
  q?: string;
}

function matches(op: OperationDto, f: ActivityFilter): boolean {
  if (f.status && !f.status.split(',').includes(op.status)) return false;
  if (f.type && !f.type.split(',').includes(op.type)) return false;
  if (f.integrationId && f.integrationId !== op.integrationId) return false;
  if (f.q) return op.subject.toLowerCase().includes(f.q.toLowerCase());
  return true;
}

export function ActivityTable({
  initial,
  routes,
  integrations,
  filter,
  locale,
}: {
  initial: Page<OperationDto>;
  routes: RouteMap;
  integrations: Array<{ id: string; name: string }>;
  filter: ActivityFilter;
  locale: Locale;
}) {
  const t = dictionary(locale);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [items, setItems] = useState(initial.items);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [incoming, setIncoming] = useState<OperationDto[]>([]);
  const [fresh, setFresh] = useState(() => new Set<string>());
  const [loading, setLoading] = useState(false);
  const search = useRef<HTMLInputElement>(null);

  // keep the list stable while someone reads it: new rows wait behind a button, updates apply in place
  useLive((event) => {
    if (event.type !== 'operation') return;
    const op = event.operation;
    setItems((current) => {
      if (!current.some((o) => o.id === op.id)) {
        if (matches(op, filter)) {
          setIncoming((queue) => [op, ...queue.filter((o) => o.id !== op.id)]);
        }
        return current;
      }
      return current.map((o) => (o.id === op.id ? op : o));
    });
    setIncoming((queue) => queue.map((o) => (o.id === op.id ? op : o)));
  });

  function setParam(key: keyof ActivityFilter, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    startTransition(() => router.replace(`${pathname}?${next.toString()}`));
  }

  async function loadMore() {
    if (!cursor) return;
    setLoading(true);
    const query = new URLSearchParams({ ...stripEmpty(filter), cursor, limit: '50' });
    const page = await get<Page<OperationDto>>(`/api/operations?${query.toString()}`).finally(() =>
      setLoading(false),
    );
    setItems((current) => [...current, ...page.items.filter((p) => !current.some((c) => c.id === p.id))]);
    setCursor(page.nextCursor);
  }

  function showIncoming() {
    setItems((current) => [...incoming, ...current.filter((c) => !incoming.some((i) => i.id === c.id))]);
    setFresh(new Set(incoming.map((o) => o.id)));
    setIncoming([]);
  }

  return (
    <div className="rounded-lg border border-rule bg-surface">
      <div className="flex flex-wrap items-end gap-2 border-b border-rule p-3">
        <search className="min-w-56 flex-1">
          <form
            className="relative"
            onSubmit={(e) => {
              e.preventDefault();
              setParam('q', search.current?.value.trim() ?? '');
            }}
          >
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-faint" aria-hidden />
            <input
              ref={search}
              defaultValue={filter.q}
              type="search"
              aria-label={t.activity.search}
              placeholder={t.activity.search}
              className={`${inputClass} w-full pl-8`}
            />
          </form>
        </search>
        <ListFilter className="mb-2.5 hidden size-4 text-faint sm:block" aria-hidden />
        <select
          aria-label={t.activity.allStatuses}
          className={inputClass}
          value={filter.status ?? ''}
          onChange={(e) => setParam('status', e.target.value)}
        >
          <option value="">{t.activity.allStatuses}</option>
          {OPERATION_STATUSES.map((s: OperationStatus) => (
            <option key={s} value={s}>
              {t.status[s]}
            </option>
          ))}
        </select>
        <select
          aria-label={t.activity.allTypes}
          className={inputClass}
          value={filter.type ?? ''}
          onChange={(e) => setParam('type', e.target.value)}
        >
          <option value="">{t.activity.allTypes}</option>
          {OPERATION_TYPES.map((type) => (
            <option key={type} value={type}>
              {t.types[type]}
            </option>
          ))}
        </select>
        <select
          aria-label={t.activity.allIntegrations}
          className={inputClass}
          value={filter.integrationId ?? ''}
          onChange={(e) => setParam('integrationId', e.target.value)}
        >
          <option value="">{t.activity.allIntegrations}</option>
          {integrations.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
        {pending && <LoaderCircle className="mb-2.5 size-4 animate-spin text-faint" aria-label="Loading" />}
      </div>

      {incoming.length > 0 && (
        <div className="border-b border-rule bg-accent-soft/50 px-4 py-2 text-center">
          <button
            type="button"
            onClick={showIncoming}
            className="text-sm font-medium text-accent hover:underline"
          >
            {t.activity.newItems(incoming.length)}
          </button>
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState title={t.activity.empty} hint={t.activity.emptyHint} />
      ) : (
        <>
          <div
            aria-hidden
            className="hidden grid-cols-[80px_minmax(0,1.6fr)_minmax(0,1fr)_120px_72px_96px] gap-x-4 border-b border-rule px-4 py-2 text-xs text-muted md:grid"
          >
            <span>{t.activity.columns.route}</span>
            <span>{t.activity.columns.what}</span>
            <span />
            <span>{t.activity.columns.status}</span>
            <span>{t.activity.columns.time}</span>
            <span className="text-right">{t.activity.columns.when}</span>
          </div>
          <OperationRows items={items} routes={routes} locale={locale} fresh={fresh} />
        </>
      )}

      {cursor && (
        <div className="border-t border-rule p-3 text-center">
          <Button onClick={() => void loadMore()} disabled={loading}>
            {loading && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
            {t.activity.loadMore}
          </Button>
        </div>
      )}
    </div>
  );
}

function stripEmpty(filter: ActivityFilter): Record<string, string> {
  return Object.fromEntries(Object.entries(filter).filter(([, v]) => Boolean(v))) as Record<string, string>;
}
