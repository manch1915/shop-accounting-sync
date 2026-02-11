import type { ProductMappingDto, ValueMappingDto } from '@sas/shared';
import clsx from 'clsx';
import { Search } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { EmptyState, inputClass, PageHeader } from '@/components/ui';
import { money } from '@/lib/format';
import { getIntegrations } from '@/lib/routes';
import { api, getDictionary, getLocale } from '@/lib/server';

export const metadata: Metadata = { title: 'Mapping' };

type Params = Promise<{ tab?: string; integrationId?: string; q?: string; unmatched?: string }>;

export default async function MappingPage({ searchParams }: { searchParams: Params }) {
  const params = await searchParams;
  const tab = params.tab === 'values' ? 'values' : 'products';
  const integrations = await getIntegrations();
  const integrationId = params.integrationId ?? integrations[0]?.id ?? '';
  const integration = integrations.find((i) => i.id === integrationId);
  const query = new URLSearchParams({ integrationId });
  if (params.q) query.set('q', params.q);
  if (params.unmatched === 'true') query.set('unmatched', 'true');

  const [t, locale, products, values] = await Promise.all([
    getDictionary(),
    getLocale(),
    tab === 'products'
      ? api<ProductMappingDto[]>(`/api/mappings/products?${query.toString()}`)
      : Promise.resolve([]),
    tab === 'values'
      ? api<ValueMappingDto[]>(`/api/mappings/values?integrationId=${integrationId}`)
      : Promise.resolve([]),
  ]);
  const href = (patch: Record<string, string>) =>
    `/mapping?${new URLSearchParams({ tab, integrationId, ...patch }).toString()}`;

  return (
    <>
      <PageHeader title={t.mapping.title} lead={t.mapping.lead} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {integrations.map((i) => (
          <Link
            key={i.id}
            href={`/mapping?${new URLSearchParams({ tab, integrationId: i.id }).toString()}`}
            aria-current={i.id === integrationId ? 'true' : undefined}
            className={clsx(
              'rounded-md border px-3 py-1.5 text-sm',
              i.id === integrationId
                ? 'border-accent bg-accent-soft font-medium text-accent'
                : 'border-rule text-muted hover:text-ink',
            )}
          >
            {i.name}
          </Link>
        ))}
        <span className="mx-2 h-5 w-px bg-rule" aria-hidden />
        {(['products', 'values'] as const).map((name) => (
          <Link
            key={name}
            href={`/mapping?${new URLSearchParams({ tab: name, integrationId }).toString()}`}
            aria-current={tab === name ? 'page' : undefined}
            className={clsx(
              'rounded-md px-3 py-1.5 text-sm',
              tab === name
                ? 'bg-surface font-medium shadow-[inset_0_0_0_1px_var(--rule)]'
                : 'text-muted hover:text-ink',
            )}
          >
            {name === 'products' ? t.mapping.products : t.mapping.values}
          </Link>
        ))}
      </div>

      {tab === 'products' ? (
        <div className="rounded-lg border border-rule bg-surface">
          <form className="flex flex-wrap items-center gap-3 border-b border-rule p-3" action="/mapping">
            <input type="hidden" name="tab" value="products" />
            <input type="hidden" name="integrationId" value={integrationId} />
            <div className="relative min-w-56 flex-1">
              <Search
                className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-faint"
                aria-hidden
              />
              <input
                type="search"
                name="q"
                defaultValue={params.q}
                placeholder={t.mapping.search}
                aria-label={t.mapping.search}
                className={`${inputClass} w-full pl-8`}
              />
            </div>
            <Link
              href={href({
                ...(params.q ? { q: params.q } : {}),
                unmatched: params.unmatched === 'true' ? 'false' : 'true',
              })}
              aria-pressed={params.unmatched === 'true'}
              className={clsx(
                'rounded-md border px-3 py-1.5 text-sm',
                params.unmatched === 'true'
                  ? 'border-warn bg-warn-soft text-warn'
                  : 'border-rule text-muted hover:text-ink',
              )}
            >
              {t.mapping.onlyUnmatched}
            </Link>
          </form>
          {products.length === 0 ? (
            <EmptyState title={t.mapping.empty} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr className="border-b border-rule">
                    <th className="px-4 py-2 font-normal">{t.mapping.store}</th>
                    <th className="px-4 py-2 font-normal">{t.mapping.accounting}</th>
                    <th className="px-4 py-2 font-normal">{t.mapping.matchedBy}</th>
                    <th className="px-4 py-2 text-right font-normal">{t.mapping.stock}</th>
                    <th className="px-4 py-2 text-right font-normal">{t.mapping.price}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {products.map((m) => (
                    <tr key={m.id} className={clsx(!m.accountingProductId && 'bg-warn-soft/40')}>
                      <td className="px-4 py-2">
                        <span className="block">{m.storeName}</span>
                        <span className="font-mono text-xs text-muted">{m.storeSku || '—'}</span>
                      </td>
                      <td className="px-4 py-2">
                        {m.accountingProductId ? (
                          <>
                            <span className="block">{m.accountingName}</span>
                            <span className="font-mono text-xs text-muted">
                              {m.accountingProductId.slice(0, 18)}
                            </span>
                          </>
                        ) : (
                          <span className="text-warn">{t.mapping.notLinked}</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-muted">
                        {m.matchedBy ? t.mapping.by[m.matchedBy] : '—'}
                      </td>
                      <td className="num px-4 py-2 text-right">{m.stock ?? '—'}</td>
                      <td className="num px-4 py-2 text-right">
                        {m.priceMinor === null || !integration
                          ? '—'
                          : money(m.priceMinor, integration.currency, locale)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          {(['tax', 'status', 'warehouse'] as const).map((kind) => (
            <section key={kind} className="rounded-lg border border-rule bg-surface">
              <h2 className="border-b border-rule px-4 py-3 text-sm font-medium">{t.mapping.kinds[kind]}</h2>
              <ul className="divide-y divide-rule text-sm">
                {values
                  .filter((v) => v.kind === kind)
                  .map((v) => (
                    <li key={v.id} className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 px-4 py-2.5">
                      <span className="truncate">{v.sourceLabel}</span>
                      <span
                        className="route-line w-6"
                        data-state={v.target ? 'succeeded' : 'blocked'}
                        aria-hidden
                      />
                      <span className={clsx('truncate text-right', !v.target && 'text-warn')}>
                        {v.targetLabel ?? t.mapping.notLinked}
                      </span>
                    </li>
                  ))}
                {values.filter((v) => v.kind === kind).length === 0 && (
                  <li className="px-4 py-6 text-center text-sm text-muted">—</li>
                )}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
