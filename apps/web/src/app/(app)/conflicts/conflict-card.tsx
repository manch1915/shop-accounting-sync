'use client';

import type { ConflictDto } from '@sas/shared';
import { Check, LoaderCircle, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import { Button, inputClass } from '@/components/ui';
import { ActionError, get, post } from '@/lib/client';
import { dictionary, type Locale } from '@/lib/i18n';

type Candidate = ConflictDto['suggestions'][number];

export function ConflictCard({ conflict, locale }: { conflict: ConflictDto; locale: Locale }) {
  const t = dictionary(locale);
  const router = useRouter();
  const listId = useId();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Candidate[] | null>(null);
  const [chosen, setChosen] = useState<Candidate | null>(conflict.suggestions[0] ?? null);
  const [state, setState] = useState<'idle' | 'saving' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  // search the accounting catalog as the person types, a quarter second after the last key
  useEffect(() => {
    // with suggestions on screen there is nothing to fetch until the person types
    if (!query.trim() && conflict.kind === 'sku_not_mapped' && conflict.suggestions.length > 0) {
      setResults(null);
      return;
    }
    const timer = setTimeout(async () => {
      const found = await get<Candidate[]>(
        `/api/conflicts/${conflict.id}/candidates?q=${encodeURIComponent(query.trim())}`,
      ).catch(() => []);
      setResults(found);
    }, 250);
    return () => clearTimeout(timer);
  }, [query, conflict.id, conflict.kind, conflict.suggestions.length]);

  async function link() {
    if (!chosen) return;
    setState('saving');
    try {
      const res = await post<{ resumed: number }>(`/api/conflicts/${conflict.id}/resolve`, {
        target: chosen.externalId,
        targetLabel: chosen.label,
      });
      setState('done');
      setMessage(t.conflicts.linked(res.resumed));
      setTimeout(() => router.refresh(), 1200);
    } catch (err) {
      setState('error');
      setMessage(
        err instanceof ActionError && err.status === 403 ? t.common.forbidden : (err as Error).message,
      );
    }
  }

  const list = results ?? conflict.suggestions;
  const details = conflict.details;

  return (
    <article className="grid gap-5 rounded-lg border border-rule border-l-4 border-l-warn bg-surface p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <div className="min-w-0">
        <p className="text-sm text-warn">{t.conflicts.kinds[conflict.kind]}</p>
        <h2 className="mt-1 text-lg font-semibold">
          {conflict.kind === 'tax_not_mapped' ? `${conflict.key}%` : (details.name ?? conflict.key)}
        </h2>
        {details.sku && <p className="num font-mono text-sm text-muted">{details.sku}</p>}
        <p className="mt-3 text-sm">
          {conflict.integrationName}
          <span className="ml-3 rounded bg-warn-soft px-1.5 py-0.5 text-xs font-medium text-warn">
            {t.conflicts.waiting(conflict.blockedOperations)}
          </span>
        </p>
      </div>

      <div className="min-w-0">
        {conflict.kind === 'sku_not_mapped' && (
          <div className="relative mb-3">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-faint" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t.conflicts.searchCatalog}
              aria-label={t.conflicts.searchCatalog}
              aria-controls={listId}
              className={`${inputClass} w-full pl-8`}
            />
          </div>
        )}
        {results === null && conflict.suggestions.length > 0 && (
          <p className="mb-1.5 text-xs text-muted">{t.conflicts.suggestions}</p>
        )}
        <ul id={listId} className="max-h-56 space-y-1 overflow-auto" aria-label={t.conflicts.suggestions}>
          {list.map((c) => {
            const active = chosen?.externalId === c.externalId;
            return (
              <li key={c.externalId}>
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => setChosen(c)}
                  className={`flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left text-sm ${
                    active ? 'border-accent bg-accent-soft' : 'border-rule hover:bg-sunken'
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{c.label}</span>
                    {c.hint && <span className="block truncate font-mono text-xs text-muted">{c.hint}</span>}
                  </span>
                  {c.score > 0 && (
                    <span className="num shrink-0 text-xs text-muted">
                      {Math.round(c.score * 100)}% {t.conflicts.match}
                    </span>
                  )}
                  {active && <Check className="size-4 shrink-0 text-accent" aria-hidden />}
                </button>
              </li>
            );
          })}
        </ul>
        {results !== null && results.length === 0 && (
          <p className="rounded-md border border-dashed border-rule-strong px-3 py-3 text-sm text-muted">
            {t.conflicts.nothingFound}
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            disabled={!chosen || state === 'saving' || state === 'done'}
            onClick={() => void link()}
          >
            {state === 'saving' && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
            {state === 'done' && <Check className="size-4" aria-hidden />}
            {t.conflicts.link}
          </Button>
          <span role="status" className={state === 'error' ? 'text-sm text-bad' : 'text-sm text-ok'}>
            {message}
          </span>
        </div>
      </div>
    </article>
  );
}
