import type { StatsDto } from '@sas/shared';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { LiveIndicator, Preferences, SignOut } from '@/components/header-controls';
import { LiveProvider } from '@/components/live';
import { MobileNav, SideNav } from '@/components/nav';
import { api, getDictionary, getLocale, getSession, getTheme } from '@/lib/server';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const [session, t, locale, theme, stats] = await Promise.all([
    getSession(),
    getDictionary(),
    getLocale(),
    getTheme(),
    api<StatsDto>('/api/overview?days=1'),
  ]);
  const counts = { conflicts: stats.totals.openConflicts, failed: stats.totals.deadJobs };

  return (
    <LiveProvider>
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2"
      >
        {t.shell.skip}
      </a>
      <div className="lg:grid lg:min-h-dvh lg:grid-cols-[232px_1fr]">
        <aside className="hidden border-r border-rule lg:block">
          <div className="sticky top-0 flex h-dvh flex-col">
            <Link href="/" className="flex h-14 items-center gap-2 px-5 font-semibold tracking-tight">
              <Logo />
              Shop sync
            </Link>
            <SideNav t={t.nav} counts={counts} />
            <div className="mt-auto space-y-1 border-t border-rule px-5 py-4 text-xs text-muted">
              <p className="truncate font-medium text-ink">{session.workspace.name}</p>
              <p className="truncate">{session.user.email}</p>
            </div>
          </div>
        </aside>

        <div className="min-w-0">
          <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-rule bg-paper/90 px-3 backdrop-blur sm:px-6">
            <MobileNav t={t.nav} menuLabel={t.shell.menu} counts={counts} />
            <Link href="/" className="flex items-center gap-2 font-semibold lg:hidden">
              <Logo />
              <span className="sr-only sm:not-sr-only">Shop sync</span>
            </Link>
            <LiveIndicator t={t.shell} />
            {session.demo && (
              <span className="hidden items-center gap-2 text-xs md:inline-flex" title={t.shell.demoHint}>
                <span className="rounded bg-accent-soft px-1.5 py-0.5 font-medium text-accent">
                  {t.shell.demo}
                </span>
                <span className="hidden text-muted xl:inline">{t.shell.demoHint}</span>
              </span>
            )}
            <div className="ml-auto flex items-center gap-1">
              <Preferences t={t.shell} locale={locale} theme={theme} />
              <SignOut label={t.shell.signOut} />
            </div>
          </header>
          <main id="content" className="mx-auto w-full max-w-[1320px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            {children}
          </main>
        </div>
      </div>
    </LiveProvider>
  );
}

function Logo() {
  // two systems and the line between them, same idea as the route rows
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden>
      <rect x="1.5" y="8" width="7" height="8" rx="2" fill="var(--accent)" />
      <rect x="15.5" y="8" width="7" height="8" rx="2" fill="var(--ink)" />
      <path d="M8.5 12h7" stroke="var(--ok)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
