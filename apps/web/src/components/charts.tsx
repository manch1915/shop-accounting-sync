'use client';

import type { StatsDto } from '@sas/shared';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { duration, percent, shortDate } from '@/lib/format';
import type { Locale } from '@/lib/i18n';

type Daily = StatsDto['daily'][number];

const axis = { fontSize: 11, fill: 'var(--faint)' };

function Frame({ children, label }: { children: React.ReactElement; label: string }) {
  return (
    <figure className="h-56 w-full" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </figure>
  );
}

interface TipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ dataKey?: unknown; name?: unknown; value?: unknown; color?: string }>;
  label?: unknown;
  locale: Locale;
  format: (v: number) => string;
}

function Tip({ active, payload, label, locale, format }: TipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-rule bg-surface px-3 py-2 text-xs shadow-sm">
      <p className="mb-1 font-medium">{shortDate(String(label), locale)}</p>
      {payload.map((p) => (
        <p key={String(p.dataKey)} className="num flex items-center gap-2 text-muted">
          <span className="size-2 rounded-sm" style={{ background: p.color }} />
          <span className="flex-1">{String(p.name)}</span>
          <span className="text-ink">{format(Number(p.value))}</span>
        </p>
      ))}
    </div>
  );
}

export function OrdersChart({
  data,
  locale,
  labels,
}: {
  data: Daily[];
  locale: Locale;
  labels: { synced: string; failed: string; title: string };
}) {
  return (
    <Frame label={labels.title}>
      <BarChart data={data} margin={{ top: 8, right: 4, left: -18, bottom: 0 }} barCategoryGap="24%">
        <CartesianGrid vertical={false} stroke="var(--rule)" />
        <XAxis
          dataKey="date"
          tickFormatter={(d) => shortDate(d, locale)}
          tick={axis}
          tickLine={false}
          axisLine={false}
          minTickGap={16}
        />
        <YAxis tick={axis} tickLine={false} axisLine={false} allowDecimals={false} width={40} />
        <Tooltip
          cursor={{ fill: 'var(--sunken)' }}
          content={({ active, payload, label }) => (
            <Tip active={active} payload={payload} label={label} locale={locale} format={(v) => String(v)} />
          )}
        />
        <Bar
          dataKey="ordersSynced"
          name={labels.synced}
          stackId="o"
          fill="var(--chart-1)"
          radius={[0, 0, 0, 0]}
        />
        <Bar
          dataKey="ordersFailed"
          name={labels.failed}
          stackId="o"
          fill="var(--chart-2)"
          radius={[2, 2, 0, 0]}
        />
      </BarChart>
    </Frame>
  );
}

export function LatencyChart({
  data,
  locale,
  labels,
}: {
  data: Daily[];
  locale: Locale;
  labels: { p50: string; p95: string; title: string };
}) {
  return (
    <Frame label={labels.title}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--rule)" />
        <XAxis
          dataKey="date"
          tickFormatter={(d) => shortDate(d, locale)}
          tick={axis}
          tickLine={false}
          axisLine={false}
          minTickGap={16}
        />
        <YAxis
          tick={axis}
          tickLine={false}
          axisLine={false}
          width={48}
          tickFormatter={(v: number) => duration(v, locale)}
        />
        <Tooltip
          content={({ active, payload, label }) => (
            <Tip
              active={active}
              payload={payload}
              label={label}
              locale={locale}
              format={(v) => duration(v, locale)}
            />
          )}
        />
        <Line
          type="monotoneX"
          dataKey="p95Ms"
          name={labels.p95}
          stroke="var(--chart-1)"
          strokeWidth={2}
          dot={false}
          connectNulls
        />
        <Line
          type="monotoneX"
          dataKey="p50Ms"
          name={labels.p50}
          stroke="var(--chart-3)"
          strokeWidth={1.5}
          dot={false}
          connectNulls
        />
      </LineChart>
    </Frame>
  );
}

export function ErrorShareChart({ data, locale, title }: { data: Daily[]; locale: Locale; title: string }) {
  const rows = data.map((d) => ({ date: d.date, share: d.operations ? d.errors / d.operations : 0 }));
  return (
    <Frame label={title}>
      <LineChart data={rows} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--rule)" />
        <XAxis
          dataKey="date"
          tickFormatter={(d) => shortDate(d, locale)}
          tick={axis}
          tickLine={false}
          axisLine={false}
          minTickGap={16}
        />
        <YAxis
          tick={axis}
          tickLine={false}
          axisLine={false}
          width={48}
          tickFormatter={(v: number) => percent(v, locale)}
        />
        <Tooltip
          content={({ active, payload, label }) => (
            <Tip
              active={active}
              payload={payload}
              label={label}
              locale={locale}
              format={(v) => percent(v, locale)}
            />
          )}
        />
        <Line
          type="monotoneX"
          dataKey="share"
          name={title}
          stroke="var(--chart-2)"
          strokeWidth={2}
          dot={false}
        />
      </LineChart>
    </Frame>
  );
}
