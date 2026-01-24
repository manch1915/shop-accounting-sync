'use client';

import clsx from 'clsx';
import {
  Activity,
  BellRing,
  Cable,
  GitCompareArrows,
  LayoutDashboard,
  type LucideIcon,
  Menu,
  OctagonAlert,
  Shuffle,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import type { Dictionary } from '@/lib/i18n';

interface Item {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
  tone?: 'bad' | 'warn';
}

function items(t: Dictionary['nav'], counts: { conflicts: number; failed: number }): Item[] {
  return [
    { href: '/', label: t.overview, icon: LayoutDashboard },
    { href: '/activity', label: t.activity, icon: Activity },
    { href: '/failed', label: t.failed, icon: OctagonAlert, badge: counts.failed, tone: 'bad' },
    { href: '/conflicts', label: t.conflicts, icon: GitCompareArrows, badge: counts.conflicts, tone: 'warn' },
    { href: '/mapping', label: t.mapping, icon: Shuffle },
    { href: '/connections', label: t.connections, icon: Cable },
    { href: '/alerts', label: t.alerts, icon: BellRing },
  ];
}

function NavList({ list, onNavigate }: { list: Item[]; onNavigate?: () => void }) {
  const path = usePathname();
  return (
    <ul className="space-y-0.5">
      {list.map(({ href, label, icon: Icon, badge, tone }) => {
        const active = href === '/' ? path === '/' : path.startsWith(href);
        return (
          <li key={href}>
            <Link
              href={href}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              className={clsx(
                'flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors',
                active
                  ? 'bg-surface font-medium text-ink shadow-[inset_0_0_0_1px_var(--rule)]'
                  : 'text-muted hover:bg-sunken hover:text-ink',
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden strokeWidth={1.75} />
              <span className="flex-1">{label}</span>
              {badge ? (
                <span
                  className={clsx(
                    'num rounded px-1.5 text-xs leading-5 font-medium',
                    tone === 'bad' ? 'bg-bad-soft text-bad' : 'bg-warn-soft text-warn',
                  )}
                >
                  {badge}
                </span>
              ) : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function SideNav({
  t,
  counts,
}: {
  t: Dictionary['nav'];
  counts: { conflicts: number; failed: number };
}) {
  return (
    <nav aria-label="Main" className="px-3">
      <NavList list={items(t, counts)} />
    </nav>
  );
}

export function MobileNav({
  t,
  menuLabel,
  counts,
}: {
  t: Dictionary['nav'];
  menuLabel: string;
  counts: { conflicts: number; failed: number };
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const path = usePathname();
  // biome-ignore lint/correctness/useExhaustiveDependencies: close the sheet whenever the route changes
  useEffect(() => dialog.current?.close(), [path]);

  return (
    <>
      <button
        type="button"
        onClick={() => dialog.current?.showModal()}
        className="grid size-9 place-items-center rounded-md hover:bg-sunken lg:hidden"
        aria-label={menuLabel}
      >
        <Menu className="size-5" aria-hidden />
      </button>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click only; Esc closes a modal dialog natively */}
      <dialog
        ref={dialog}
        aria-label={menuLabel}
        className="m-0 h-dvh max-h-none w-72 max-w-[85vw] bg-paper p-0 text-ink backdrop:bg-black/40"
        onClick={(e) => {
          if (e.target === dialog.current) dialog.current?.close();
        }}
      >
        <div className="flex h-14 items-center justify-end px-3">
          <button
            type="button"
            onClick={() => dialog.current?.close()}
            className="grid size-9 place-items-center rounded-md hover:bg-sunken"
            aria-label="Close"
          >
            <X className="size-5" aria-hidden />
          </button>
        </div>
        <nav aria-label="Main" className="px-3">
          <NavList list={items(t, counts)} onNavigate={() => dialog.current?.close()} />
        </nav>
      </dialog>
    </>
  );
}
