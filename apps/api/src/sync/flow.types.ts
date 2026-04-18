import type { IntegrationFlags, OperationType } from '@sas/shared';
import type { AccountingConnector, StoreConnector } from '../domain/connectors.js';
import { buildMatchKey } from '../domain/customer-key.js';
import type { Customer } from '../domain/models.js';
import type { Connection, Integration, Operation } from '../generated/prisma/client.js';

export type IntegrationWithConnections = Integration & { store: Connection; accounting: Connection };

export interface IntegrationSettings {
  warehouseId?: string | null;
  /** short prefix for the reference we leave on accounting documents, e.g. "woo" */
  refPrefix?: string;
}

export interface FlowContext {
  operation: Operation;
  integration: IntegrationWithConnections;
  flags: IntegrationFlags;
  settings: IntegrationSettings;
  store: StoreConnector;
  accounting: AccountingConnector;
  log(level: 'info' | 'warn' | 'error', message: string): Promise<void>;
  /** webhooks only carry an id; once the order is fetched the log can show its real number */
  rename(subject: string): Promise<void>;
}

export type FlowResult = Record<string, unknown> & { skipped?: string };

export interface FlowHandler {
  readonly type: OperationType;
  run(ctx: FlowContext): Promise<FlowResult>;
}

export const FLOW_HANDLERS = Symbol('FLOW_HANDLERS');

export function refPrefix(ctx: Pick<FlowContext, 'integration' | 'settings'>): string {
  return ctx.settings.refPrefix ?? (ctx.integration.store.provider === 'shopify' ? 'shop' : 'woo');
}

export function orderRef(ctx: Pick<FlowContext, 'integration' | 'settings'>, orderId: string): string {
  return `${refPrefix(ctx)}-${orderId}`;
}

export function customerOf(
  ctx: Pick<FlowContext, 'integration' | 'settings'>,
  order: { externalId: string; customer: Customer },
): Customer {
  return { ...order.customer, matchKey: buildMatchKey(refPrefix(ctx), order.customer, order.externalId) };
}
