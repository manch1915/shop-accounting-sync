import type {
  AccountingProvider,
  ConflictKind,
  ConnectionStatus,
  MatchMethod,
  OperationStatus,
  OperationType,
  Provider,
  Role,
  StoreProvider,
} from './enums.js';
import type { ErrorCode } from './errors.js';

export interface SessionDto {
  user: { id: string; name: string; email: string; role: Role };
  workspace: { id: string; name: string };
  demo: boolean;
  canAct: boolean;
}

export interface ConnectionDto {
  id: string;
  provider: Provider;
  kind: 'store' | 'accounting';
  name: string;
  baseUrl: string;
  status: ConnectionStatus;
  statusReason: string | null;
  lastSyncAt: string | null;
  authType: 'api_key' | 'oauth2' | 'basic';
  tokenExpiresAt: string | null;
  rateLimit: { used: number; limit: number; windowSec: number } | null;
}

export interface IntegrationFlags {
  exportOrders: boolean;
  exportPayments: boolean;
  pushStock: boolean;
  pushPrices: boolean;
  publishNewProducts: boolean;
}

export interface IntegrationDto {
  id: string;
  name: string;
  store: ConnectionDto & { provider: StoreProvider };
  accounting: ConnectionDto & { provider: AccountingProvider };
  flags: IntegrationFlags;
  currency: string;
  reconcileEveryMin: number;
  stats24h: { orders: number; failed: number; p95Ms: number | null };
}

export interface OperationDto {
  id: string;
  integrationId: string;
  integrationName: string;
  type: OperationType;
  status: OperationStatus;
  subject: string;
  subjectUrl: string | null;
  attempts: number;
  maxAttempts: number;
  durationMs: number | null;
  errorCode: ErrorCode | null;
  errorParams: Record<string, string | number> | null;
  errorDetail: string | null;
  nextRetryAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HttpExchangeDto {
  id: string;
  attempt: number;
  provider: Provider;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  status: number | null;
  responseHeaders: Record<string, string>;
  responseBody: string | null;
  durationMs: number;
  error: string | null;
  createdAt: string;
}

export interface OperationEventDto {
  id: string;
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface OperationDetailDto extends OperationDto {
  payload: unknown;
  result: unknown;
  events: OperationEventDto[];
  exchanges: HttpExchangeDto[];
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}

export interface ErrorGroupDto {
  errorCode: ErrorCode;
  provider: Provider;
  params: Record<string, string | number>;
  count: number;
  lastSeenAt: string;
  operationIds: string[];
  sample: OperationDto;
}

export interface ConflictDto {
  id: string;
  integrationId: string;
  integrationName: string;
  kind: ConflictKind;
  key: string;
  details: Record<string, string | number | null>;
  blockedOperations: number;
  createdAt: string;
  suggestions: Array<{ externalId: string; label: string; hint: string | null; score: number }>;
}

export interface ProductMappingDto {
  id: string;
  integrationId: string;
  storeSku: string;
  storeName: string;
  storeProductId: string;
  accountingProductId: string | null;
  accountingName: string | null;
  matchedBy: MatchMethod | null;
  barcode: string | null;
  stock: number | null;
  priceMinor: number | null;
  updatedAt: string;
}

export interface ValueMappingDto {
  id: string;
  integrationId: string;
  kind: 'warehouse' | 'status' | 'tax';
  source: string;
  sourceLabel: string;
  target: string | null;
  targetLabel: string | null;
}

export interface StatsDto {
  range: { from: string; to: string };
  totals: {
    ordersSynced: number;
    ordersFailed: number;
    successRate: number;
    p95Ms: number | null;
    openConflicts: number;
    deadJobs: number;
    retryingJobs: number;
  };
  daily: Array<{
    date: string;
    ordersSynced: number;
    ordersFailed: number;
    operations: number;
    errors: number;
    p50Ms: number | null;
    p95Ms: number | null;
  }>;
}

export interface AlertDto {
  id: string;
  channel: 'telegram' | 'log';
  severity: 'warning' | 'critical';
  title: string;
  body: string;
  delivered: boolean;
  createdAt: string;
}

export type LiveEvent =
  | { type: 'operation'; operation: OperationDto }
  | { type: 'connection'; connectionId: string; status: ConnectionStatus }
  | { type: 'conflict'; conflictId: string; resolved: boolean };
