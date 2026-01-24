import type { OperationStatus } from '@sas/shared';
import clsx from 'clsx';
import type { ComponentProps, ReactNode } from 'react';

export function PageHeader({ title, lead, actions }: { title: string; lead?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {lead && <p className="mt-1 max-w-[72ch] text-pretty text-muted">{lead}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Panel({
  title,
  aside,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={clsx('rounded-lg border border-rule bg-surface', className)}>
      {title && (
        <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-rule px-4 py-3">
          <h2 className="text-sm font-medium whitespace-nowrap">{title}</h2>
          {aside}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

const STATUS_STYLE: Record<OperationStatus, { dot: string; text: string }> = {
  succeeded: { dot: 'bg-ok', text: 'text-ok' },
  skipped: { dot: 'border border-faint', text: 'text-muted' },
  queued: { dot: 'border-2 border-accent', text: 'text-accent' },
  running: { dot: 'bg-accent animate-pulse', text: 'text-accent' },
  retrying: { dot: 'bg-warn', text: 'text-warn' },
  blocked: { dot: 'rounded-none bg-warn', text: 'text-warn' },
  dead: { dot: 'rounded-none rotate-45 bg-bad', text: 'text-bad' },
};

/** Colour plus a distinct shape plus a word, so status never depends on colour alone. */
export function StatusBadge({ status, label }: { status: OperationStatus; label: string }) {
  const style = STATUS_STYLE[status];
  return (
    <span
      className={clsx('inline-flex items-center gap-1.5 text-sm font-medium whitespace-nowrap', style.text)}
    >
      <span aria-hidden className={clsx('size-2 shrink-0 rounded-full', style.dot)} />
      {label}
    </span>
  );
}

export function EmptyState({ title, hint, icon }: { title: string; hint?: string; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      {icon && <div className="mb-3 text-faint">{icon}</div>}
      <p className="font-medium">{title}</p>
      {hint && <p className="mt-1 max-w-[48ch] text-sm text-muted">{hint}</p>}
    </div>
  );
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  ...props
}: ComponentProps<'button'> & { variant?: 'primary' | 'secondary' | 'ghost'; size?: 'sm' | 'md' }) {
  return (
    <button
      type="button"
      {...props}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-[background-color,filter,transform] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50',
        size === 'sm' ? 'h-8 px-2.5 text-sm' : 'h-9 px-3.5 text-sm',
        variant === 'primary' && 'bg-accent text-accent-ink hover:brightness-110',
        variant === 'secondary' && 'border border-rule-strong bg-surface hover:bg-sunken',
        variant === 'ghost' && 'text-muted hover:bg-sunken hover:text-ink',
        className,
      )}
    />
  );
}

export const inputClass =
  'h-9 rounded-md border border-rule-strong bg-surface px-2.5 text-sm text-ink placeholder:text-faint';
