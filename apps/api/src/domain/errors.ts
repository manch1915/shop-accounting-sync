import { type ErrorCode, PROVIDER_NAMES as NAMES, type Provider, RETRYABLE } from '@sas/shared';

export class SyncError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly params: Record<string, string | number> = {},
    readonly detail: string | null = null,
  ) {
    super(message);
    this.name = new.target.name;
  }

  get retryable(): boolean {
    return RETRYABLE[this.code];
  }
}

export class RateLimitedError extends SyncError {
  constructor(
    provider: Provider,
    readonly retryAfterMs: number,
    detail: string | null = null,
  ) {
    super('rate_limited', `${NAMES[provider]} rate limit, retry in ${retryAfterMs} ms`, { provider }, detail);
  }
}

export class ProviderUnavailableError extends SyncError {
  constructor(provider: Provider, status: number | null, detail: string | null = null) {
    super(
      'provider_unavailable',
      `${NAMES[provider]} unavailable (${status ?? 'network'})`,
      { provider },
      detail,
    );
  }
}

export class TimeoutError extends SyncError {
  constructor(provider: Provider, timeoutMs: number) {
    super('timeout', `${NAMES[provider]} did not respond in ${timeoutMs} ms`, { provider });
  }
}

export class AuthError extends SyncError {
  constructor(provider: Provider, detail: string | null = null) {
    super('auth_failed', `${NAMES[provider]} rejected credentials`, { provider }, detail);
  }
}

export class ValidationRejectedError extends SyncError {
  constructor(provider: Provider, detail: string) {
    super('validation_rejected', `${NAMES[provider]} rejected the request: ${detail}`, { provider }, detail);
  }
}

export class NotFoundError extends SyncError {
  constructor(provider: Provider, what: string) {
    super('not_found', `${what} not found in ${NAMES[provider]}`, { provider }, what);
  }
}

export type MappingErrorCode = 'sku_not_mapped' | 'tax_not_mapped' | 'status_not_mapped';

/** Raised when data cannot be sent until someone links it by hand. Blocks, never retries. */
export class MappingError extends SyncError {
  constructor(
    code: MappingErrorCode,
    readonly conflictKey: string,
    params: Record<string, string | number>,
    readonly details: Record<string, string | number | null> = {},
  ) {
    super(code, `${code}: ${conflictKey}`, params);
  }
}

export function toSyncError(err: unknown): SyncError {
  if (err instanceof SyncError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new SyncError('unknown', message, {}, err instanceof Error ? (err.stack ?? null) : null);
}
