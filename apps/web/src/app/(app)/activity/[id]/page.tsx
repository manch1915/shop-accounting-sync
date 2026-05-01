import type { HttpExchangeDto, OperationDetailDto } from '@sas/shared';
import clsx from 'clsx';
import { ArrowLeft, ExternalLink, ShieldCheck } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { CopyButton, RetryButton } from '@/components/actions';
import { OperationSubject } from '@/components/operations';
import { PROVIDER_NAMES, ProviderMark } from '@/components/provider-mark';
import { Route } from '@/components/route';
import { Panel, StatusBadge } from '@/components/ui';
import { errorText } from '@/lib/errors';
import { dateTime, duration } from '@/lib/format';
import type { Dictionary, Locale } from '@/lib/i18n';
import { getIntegrations, routeMap } from '@/lib/routes';
import { api, getDictionary, getLocale } from '@/lib/server';

export const metadata: Metadata = { title: 'Operation' };

const RETRYABLE = new Set(['dead', 'blocked', 'skipped']);

export default async function OperationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [t, locale, op, integrations] = await Promise.all([
    getDictionary(),
    getLocale(),
    api<OperationDetailDto>(`/api/operations/${encodeURIComponent(id)}`),
    getIntegrations(),
  ]);
  const route = routeMap(integrations)[op.integrationId];
  const error =
    op.errorCode && op.status !== 'succeeded' ? errorText(op.errorCode, op.errorParams, locale) : null;
  const attempts = [...new Set(op.exchanges.map((x) => x.attempt))];

  return (
    <>
      <Link
        href="/activity"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
      >
        <ArrowLeft className="size-4" aria-hidden />
        {t.detail.back}
      </Link>

      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">
            <OperationSubject op={op} locale={locale} />
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted">
            <StatusBadge status={op.status} label={t.status[op.status]} />
            {route && (
              <span className="flex w-56 items-center gap-2">
                <Route store={route.store} accounting={route.accounting} type={op.type} status={op.status} />
              </span>
            )}
            <span>{op.integrationName}</span>
            <span className="num">{dateTime(op.createdAt, locale)}</span>
            <span className="num">
              {t.detail.attempt} {op.attempts} {t.common.of} {op.maxAttempts}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {op.subjectUrl && (
            <a
              href={op.subjectUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-rule-strong bg-surface px-3.5 text-sm font-medium hover:bg-sunken"
            >
              <ExternalLink className="size-4" aria-hidden />
              {t.detail.openDocument}
            </a>
          )}
          {RETRYABLE.has(op.status) && <RetryButton ids={[op.id]} locale={locale} />}
        </div>
      </header>

      {error && (
        <section
          className={clsx(
            'mb-6 rounded-lg border p-4',
            op.status === 'dead' ? 'border-bad/40 bg-bad-soft' : 'border-warn/40 bg-warn-soft',
          )}
        >
          <h2 className={clsx('font-semibold', op.status === 'dead' ? 'text-bad' : 'text-warn')}>
            {error.title}
          </h2>
          <p className="mt-1 max-w-[80ch] text-pretty">
            <span className="font-medium">{t.detail.whatToDo}: </span>
            {error.hint}
          </p>
          {op.errorDetail && (
            <p className="mt-2 font-mono text-xs break-words text-muted">{op.errorDetail}</p>
          )}
        </section>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.6fr)]">
        <div className="space-y-4">
          <Panel title={t.detail.timeline} bodyClassName="p-4">
            <ol className="relative space-y-3 border-l border-rule pl-4">
              {op.events.map((e) => (
                <li key={e.id} className="relative">
                  <span
                    aria-hidden
                    className={clsx(
                      'absolute top-1.5 -left-[21px] size-2.5 rounded-full border-2 border-surface',
                      e.level === 'error' ? 'bg-bad' : e.level === 'warn' ? 'bg-warn' : 'bg-faint',
                    )}
                  />
                  <p className="text-sm">{e.message}</p>
                  <p className="num text-xs text-muted">{dateTime(e.at, locale)}</p>
                </li>
              ))}
            </ol>
          </Panel>
          {op.result != null && (
            <Panel title={t.detail.result} aside={<CopyButton text={pretty(op.result)} locale={locale} />}>
              <Code text={pretty(op.result)} />
            </Panel>
          )}
        </div>

        <Panel
          title={t.detail.requests}
          aside={
            <span className="inline-flex items-center gap-1.5 text-xs text-muted">
              <ShieldCheck className="size-3.5" aria-hidden />
              {t.detail.masked}
            </span>
          }
        >
          {op.exchanges.length === 0 ? (
            <p className="p-4 text-sm text-muted">{t.detail.noRequests}</p>
          ) : (
            attempts.map((attempt) => (
              <div key={attempt}>
                {attempts.length > 1 && (
                  <p className="border-b border-rule bg-sunken px-4 py-1.5 text-xs font-medium text-muted">
                    {t.detail.attempt} {attempt}
                  </p>
                )}
                <ul className="divide-y divide-rule">
                  {op.exchanges
                    .filter((x) => x.attempt === attempt)
                    .map((x) => (
                      <Exchange key={x.id} x={x} t={t} locale={locale} />
                    ))}
                </ul>
              </div>
            ))
          )}
        </Panel>
      </div>
    </>
  );
}

function Exchange({ x, t, locale }: { x: HttpExchangeDto; t: Dictionary; locale: Locale }) {
  const ok = x.status !== null && x.status < 400;
  const url = new URL(x.url);
  return (
    <li>
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-2.5 hover:bg-sunken [&::-webkit-details-marker]:hidden">
          <ProviderMark provider={x.provider} />
          <span className="w-12 shrink-0 font-mono text-xs font-medium">{x.method}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted" title={x.url}>
            {url.pathname}
            {url.search}
          </span>
          <span
            className={clsx(
              'num rounded px-1.5 font-mono text-xs leading-5',
              ok ? 'bg-ok-soft text-ok' : 'bg-bad-soft text-bad',
            )}
          >
            {x.status ?? 'ERR'}
          </span>
          <span className="num w-16 text-right text-xs text-muted">{duration(x.durationMs, locale)}</span>
        </summary>
        <div className="grid gap-0 border-t border-rule bg-sunken md:grid-cols-2">
          <Body
            title={`${t.detail.request}: ${PROVIDER_NAMES[x.provider]}`}
            headers={x.requestHeaders}
            body={x.requestBody}
            t={t}
            locale={locale}
          />
          <Body
            title={t.detail.response}
            headers={x.responseHeaders}
            body={x.error ?? x.responseBody}
            t={t}
            locale={locale}
            className="border-t border-rule md:border-t-0 md:border-l"
          />
        </div>
      </details>
    </li>
  );
}

function Body({
  title,
  headers,
  body,
  t,
  locale,
  className,
}: {
  title: string;
  headers: Record<string, string>;
  body: string | null;
  t: Dictionary;
  locale: Locale;
  className?: string;
}) {
  const headerText = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return (
    <div className={clsx('min-w-0', className)}>
      <div className="flex items-center justify-between px-4 pt-2">
        <p className="text-xs font-medium text-muted">{title}</p>
        {body && <CopyButton text={body} locale={locale} />}
      </div>
      <details className="px-4">
        <summary className="cursor-pointer text-xs text-muted">{t.detail.headers}</summary>
        <pre className="mt-1 max-h-40 overflow-auto font-mono text-[11px] leading-4 whitespace-pre-wrap text-muted">
          {headerText}
        </pre>
      </details>
      {body ? <Code text={body} /> : <p className="px-4 py-3 text-xs text-faint">{t.detail.noBody}</p>}
    </div>
  );
}

function Code({ text }: { text: string }) {
  return (
    <pre className="max-h-96 overflow-auto px-4 py-3 font-mono text-xs leading-5 break-words whitespace-pre-wrap">
      {text}
    </pre>
  );
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
