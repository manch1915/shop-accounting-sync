import type { OperationType } from '@sas/shared';

export const QUEUE_ORDERS = 'sas-orders';
export const QUEUE_CATALOG = 'sas-catalog';
export const QUEUE_MAINTENANCE = 'sas-maintenance';
export const QUEUE_DEAD = 'sas-dead-letter';
export const QUEUE_SCHEDULER = 'sas-scheduler';

export const ALL_QUEUES = [QUEUE_ORDERS, QUEUE_CATALOG, QUEUE_MAINTENANCE, QUEUE_DEAD, QUEUE_SCHEDULER];

export function queueFor(type: OperationType): string {
  switch (type) {
    case 'order.export':
    case 'payment.export':
      return QUEUE_ORDERS;
    case 'stock.push':
    case 'price.push':
    case 'product.publish':
      return QUEUE_CATALOG;
    case 'orders.reconcile':
    case 'catalog.refresh':
      return QUEUE_MAINTENANCE;
  }
}

export const MAX_ATTEMPTS = 6;
/** 5 s, 10 s, 20 s, 40 s, 80 s between attempts, with BullMQ's jitter on top */
export const BACKOFF = { type: 'exponential', delay: 5_000, jitter: 0.3 } as const;

export interface OperationJob {
  operationId: string;
}

export interface ScheduledJob {
  integrationId: string;
  type: OperationType;
}
