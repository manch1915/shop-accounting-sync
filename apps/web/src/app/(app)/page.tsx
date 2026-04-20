import type { IntegrationDto, OperationDto, Page, StatsDto } from '@sas/shared';
import Link from 'next/link';
import { ErrorShareChart, LatencyChart, OrdersChart } from '@/components/charts-lazy';
import { LiveFeed } from '@/components/live-feed';
import { PROVIDER_NAMES, ProviderMark } from '@/components/provider-mark';
import { PageHeader, Panel } from '@/components/ui';
import { count, duration, percent, relative } from '@/lib/format';
import type { Dictionary, Locale } from '@/lib/i18n';
import { getIntegrations, routeMap } from '@/lib/routes';
import { api, getDictionary, getLocale } from '@/lib/server';

export default async function OverviewPage() {
  const [t, locale, stats, integrations, recent] = await Promise.all([
    getDictionary(),
    getLocale(),
    api<StatsDto>('/api/overview?days=14'),
    getIntegrations(),
    api<Page<OperationDto>>('/api/operations?limit=12'),
  ]);
  const { totals } = stats;
  const attention = totals.openConflicts + totals.deadJobs;

  return (
    <>
      <PageHeader title={t.overview.title} lead={t.overview.range} />

      <section aria-label={t.overview.integrations} className="mb-6 grid gap-3 xl:grid-cols-2">
        {integrations.map((i) => (
          <IntegrationStrip key={i.id} integration={i} t={t} locale={locale} />
        ))}
      </section>

      <section className="mb-6 grid grid-cols-2 rounded-lg border border-rule bg-surface lg:grid-cols-4">
        <Stat label={t.overview.synced} value={count(totals.ordersSynced, locale)} />
        <Stat label={t.overview.successRate} value={percent(totals.successRate, locale)} />
        <Stat label={t.overview.p95} value={duration(totals.p95Ms, locale)} />
        <Stat
          label={t.overview.attention}
          value={count(attention, locale)}
          detail={t.overview.attentionDetail(totals.openConflicts, totals.deadJobs)}
          href={totals.openConflicts > 0 ? '/conflicts' : '/failed'}
          tone={attention > 0 ? 'warn' : undefined}
        />
      </section>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Panel
          title={t.overview.ordersPerDay}
          aside={
            <Legend
              items={[
                [t.overview.legendSynced, 'var(--chart-1)'],
                [t.overview.legendFailed, 'var(--chart-2)'],
              ]}
            />
          }
          bodyClassName="p-4"
        >
          <OrdersChart
            data={stats.daily}
            locale={locale}
            labels={{
              synced: t.overview.legendSynced,
              failed: t.overview.legendFailed,
              title: t.overview.ordersPerDay,
            }}
          />
        </Panel>
        <Panel
          title={t.overview.syncTime}
          aside={
            <Legend
              items={[
                [t.overview.p95Line, 'var(--chart-1)'],
                [t.overview.p50, 'var(--chart-3)'],
              ]}
            />
          }
          bodyClassName="p-4"
        >
          <LatencyChart
            data={stats.daily}
            locale={locale}
            labels={{ p50: t.overview.p50, p95: t.overview.p95Line, title: t.overview.syncTime }}
          />
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        <Panel title={t.overview.errorShare} bodyClassName="p-4">
          <ErrorShareChart data={stats.daily} locale={locale} title={t.overview.errorShare} />
        </Panel>
        <Panel
          title={t.overview.liveFeed}
          aside={
            <Link href="/activity" className="text-sm text-accent hover:underline">
              {t.overview.seeAll}
            </Link>
          }
        >
          <LiveFeed initial={recent.items} routes={routeMap(integrations)} locale={locale} />
        </Panel>
      </div>
    </>
  );
}

function IntegrationStrip({
  integration: i,
  t,
  locale,
}: {
  integration: IntegrationDto;
  t: Dictionary;
  locale: Locale;
}) {
  const healthy = i.store.status === 'active' && i.accounting.status === 'active';
  const lastSync = [i.store.lastSyncAt, i.accounting.lastSyncAt].filter(Boolean).sort().at(-1) ?? null;
  return (
    <Link
      href={`/activity?integrationId=${i.id}`}
      className="group grid gap-3 rounded-lg border border-rule bg-surface p-4 hover:border-rule-strong"
    >
      <div className="flex items-center gap-3">
        <span className="flex min-w-0 items-center gap-2">
          <ProviderMark provider={i.store.provider} size="md" />
          <span className="truncate text-sm">{PROVIDER_NAMES[i.store.provider]}</span>
        </span>
        <span className="route-line flex-1" data-state={healthy ? 'succeeded' : 'retrying'} />
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm">{PROVIDER_NAMES[i.accounting.provider]}</span>
          <ProviderMark provider={i.accounting.provider} size="md" />
        </span>
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h2 className="font-semibold">{i.name}</h2>
        <dl className="num flex flex-wrap gap-x-5 gap-y-1 text-sm">
          <div className="flex gap-1.5">
            <dt className="text-muted">{t.overview.last24h}</dt>
            <dd>
              {count(i.stats24h.orders, locale)} {t.overview.orders}
            </dd>
          </div>
          {i.stats24h.failed > 0 && (
            <div className="flex gap-1.5 text-bad">
              <dt>{t.status.dead}</dt>
              <dd>{i.stats24h.failed}</dd>
            </div>
          )}
          <div className="flex gap-1.5">
            <dt className="text-muted">p95</dt>
            <dd>{duration(i.stats24h.p95Ms, locale)}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-muted">{t.overview.lastSync}</dt>
            <dd>{lastSync ? relative(lastSync, locale) : t.overview.never}</dd>
          </div>
        </dl>
      </div>
    </Link>
  );
}

function Stat({
  label,
  value,
  detail,
  href,
  tone,
}: {
  label: string;
  value: string;
  detail?: string;
  href?: string;
  tone?: 'warn';
}) {
  const body = (
    <>
      <p className="text-sm text-muted">{label}</p>
      <p className={`num mt-1 text-2xl font-semibold tracking-tight ${tone === 'warn' ? 'text-warn' : ''}`}>
        {value}
      </p>
      {detail && <p className="mt-0.5 text-xs text-muted">{detail}</p>}
    </>
  );
  const cell =
    'border-rule p-4 [&:nth-child(n+3)]:border-t lg:[&:nth-child(n+3)]:border-t-0 [&:not(:first-child)]:lg:border-l odd:border-r lg:odd:border-r-0';
  return href ? (
    <Link href={href} className={`${cell} hover:bg-sunken`}>
      {body}
    </Link>
  ) : (
    <div className={cell}>{body}</div>
  );
}

function Legend({ items }: { items: Array<[string, string]> }) {
  return (
    <ul className="flex flex-wrap gap-3 text-xs text-muted">
      {items.map(([label, color]) => (
        <li key={label} className="flex items-center gap-1.5">
          <span className="size-2 rounded-sm" style={{ background: color }} />
          {label}
        </li>
      ))}
    </ul>
  );
}
