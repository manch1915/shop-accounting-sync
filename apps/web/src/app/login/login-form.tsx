'use client';

import { LoaderCircle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { ActionError, post } from '@/lib/client';
import type { Dictionary } from '@/lib/i18n';

export function LoginForm({ t }: { t: Dictionary['login'] }) {
  const router = useRouter();
  const [pending, setPending] = useState<'demo' | 'owner' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(kind: 'demo' | 'owner', action: () => Promise<unknown>) {
    setPending(kind);
    setError(null);
    try {
      await action();
      router.replace('/');
      router.refresh();
    } catch (err) {
      const status = err instanceof ActionError ? err.status : 0;
      setError(status === 401 ? t.wrong : status === 429 ? t.tooMany : t.failed);
      setPending(null);
    }
  }

  function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run('owner', () =>
      post('/api/auth/login', { email: form.get('email'), password: form.get('password') }),
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => void run('demo', () => post('/api/auth/demo'))}
        disabled={pending !== null}
        className="flex h-12 w-full items-center justify-center gap-2 rounded-md bg-accent px-4 font-medium text-accent-ink transition-[filter,transform] hover:brightness-110 active:scale-[0.99] disabled:opacity-60"
      >
        {pending === 'demo' && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
        {t.demo}
      </button>
      <p className="mt-3 text-sm text-muted">{t.demoNote}</p>

      <form onSubmit={signIn} className="mt-8 border-t border-rule pt-6">
        <h2 className="text-sm font-medium">{t.orOwner}</h2>
        <label className="mt-4 block text-sm text-muted" htmlFor="email">
          {t.email}
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          className="mt-1 h-10 w-full rounded-md border border-rule-strong bg-surface px-3 text-ink"
        />
        <label className="mt-3 block text-sm text-muted" htmlFor="password">
          {t.password}
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="mt-1 h-10 w-full rounded-md border border-rule-strong bg-surface px-3 text-ink"
        />
        <button
          type="submit"
          disabled={pending !== null}
          className="mt-5 flex h-10 w-full items-center justify-center gap-2 rounded-md border border-rule-strong px-4 text-sm font-medium hover:bg-sunken disabled:opacity-60"
        >
          {pending === 'owner' && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
          {t.signIn}
        </button>
        <p role="alert" aria-live="polite" className="mt-3 min-h-5 text-sm text-bad">
          {error}
        </p>
      </form>
    </div>
  );
}
