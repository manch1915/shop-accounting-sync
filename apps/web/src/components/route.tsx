import type { OperationStatus, OperationType, Provider } from '@sas/shared';
import clsx from 'clsx';
import { ProviderMark } from './provider-mark';

/** Which way data travels for each kind of operation. */
export function direction(type: OperationType): 'to-accounting' | 'to-store' | 'both' {
  if (type === 'order.export' || type === 'payment.export' || type === 'orders.reconcile')
    return 'to-accounting';
  if (type === 'catalog.refresh') return 'both';
  return 'to-store';
}

/**
 * Store mark, a line, accounting mark. The line carries the state: solid when synced,
 * moving dashes while running or retrying, a paused segment when on hold, a gap when failed.
 */
export function Route({
  store,
  accounting,
  type,
  status,
  className,
}: {
  store: Provider;
  accounting: Provider;
  type: OperationType;
  status: OperationStatus;
  className?: string;
}) {
  const dir = direction(type);
  const [from, to] = dir === 'to-store' ? [accounting, store] : [store, accounting];
  return (
    <span className={clsx('inline-flex w-full min-w-16 items-center gap-1.5', className)} aria-hidden>
      <ProviderMark provider={from} />
      <span className="route-line min-w-6 flex-1" data-state={status} />
      <ProviderMark provider={to} />
    </span>
  );
}
