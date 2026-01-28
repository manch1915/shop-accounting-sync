'use client';

import { Check, Copy, LoaderCircle, Play, RotateCcw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ActionError, post } from '@/lib/client';
import { dictionary, type Locale } from '@/lib/i18n';
import { Button } from './ui';

function useAction(locale: Locale) {
  const t = dictionary(locale);
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'pending' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>, done: string) {
    setState('pending');
    setMessage(null);
    try {
      await action();
      setState('done');
      setMessage(done);
      router.refresh();
    } catch (err) {
      setState('error');
      setMessage(
        err instanceof ActionError && err.status === 403 ? t.common.forbidden : (err as Error).message,
      );
    }
  }
  return { state, message, run, t };
}

export function RetryButton({ ids, locale, label }: { ids: string[]; locale: Locale; label?: string }) {
  const { state, message, run, t } = useAction(locale);
  const body = ids.length === 1 ? undefined : { ids };
  const path = ids.length === 1 ? `/api/operations/${ids[0]}/retry` : '/api/operations/retry';
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        variant="primary"
        disabled={state === 'pending' || state === 'done'}
        onClick={() => void run(() => post(path, body), t.detail.retried)}
      >
        {state === 'pending' ? (
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
        ) : state === 'done' ? (
          <Check className="size-4" aria-hidden />
        ) : (
          <RotateCcw className="size-4" aria-hidden />
        )}
        {state === 'done' ? t.detail.retrying : (label ?? t.detail.retry)}
      </Button>
      <span role="status" className={state === 'error' ? 'text-sm text-bad' : 'text-sm text-muted'}>
        {message}
      </span>
    </span>
  );
}

export function RunNowButton({
  integrationId,
  type,
  locale,
  label,
}: {
  integrationId: string;
  type: string;
  locale: Locale;
  label: string;
}) {
  const { state, message, run, t } = useAction(locale);
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        disabled={state === 'pending'}
        onClick={() =>
          void run(() => post(`/api/integrations/${integrationId}/run/${type}`), t.detail.retried)
        }
      >
        {state === 'pending' ? (
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <Play className="size-3.5" aria-hidden />
        )}
        {label}
      </Button>
      {state === 'error' && (
        <span role="status" className="text-xs text-bad">
          {message}
        </span>
      )}
    </span>
  );
}

export function CopyButton({ text, locale }: { text: string; locale: Locale }) {
  const t = dictionary(locale);
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex h-7 items-center gap-1 rounded px-2 text-xs text-muted hover:bg-sunken hover:text-ink"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      {copied ? t.detail.copied : t.detail.copy}
    </button>
  );
}
