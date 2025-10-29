import { AsyncLocalStorage } from 'node:async_hooks';
import type { Provider } from '@sas/shared';
import {
  AuthError,
  NotFoundError,
  ProviderUnavailableError,
  RateLimitedError,
  type SyncError,
  TimeoutError,
  ValidationRejectedError,
} from '../../domain/errors.js';
import { maskBody, maskHeaders, maskUrl } from '../../security/mask.js';

export interface ExchangeRecord {
  connectionId: string;
  operationId: string | null;
  attempt: number;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  status: number | null;
  responseHeaders: Record<string, string>;
  responseBody: string | null;
  durationMs: number;
  error: string | null;
}

export interface ExchangeSink {
  record(exchange: ExchangeRecord): void;
}

interface JournalScope {
  operationId: string;
  attempt: number;
}

const scope = new AsyncLocalStorage<JournalScope>();

/** Everything called inside `fn` is logged against this operation attempt. */
export function withJournalScope<T>(operationId: string, attempt: number, fn: () => Promise<T>): Promise<T> {
  return scope.run({ operationId, attempt }, fn);
}

export interface ErrorPolicy {
  /** delay requested by the provider on 429 (or its equivalent) */
  retryAfterMs(headers: Headers, body: string): number;
  /** human-readable message from an error body */
  extractMessage(body: string): string | null;
  /** some APIs signal throttling with 200 + error payload (Shopify GraphQL) */
  detectThrottle?(status: number, body: string): number | null;
}

export interface HttpClientOptions {
  provider: Provider;
  connectionId: string;
  baseUrl: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  sink: ExchangeSink;
  policy: ErrorPolicy;
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  form?: Record<string, string>;
  headers?: Record<string, string>;
  /** absolute URL, for token endpoints that live on another host */
  absolute?: boolean;
}

export interface HttpResponse<T> {
  status: number;
  headers: Headers;
  data: T;
}

export class HttpClient {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private headers: Record<string, string>;

  constructor(private readonly opts: HttpClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.headers = { accept: 'application/json', ...opts.headers };
  }

  get provider(): Provider {
    return this.opts.provider;
  }

  setHeader(name: string, value: string): void {
    this.headers = { ...this.headers, [name.toLowerCase()]: value };
  }

  get<T>(path: string, options: RequestOptions = {}): Promise<HttpResponse<T>> {
    return this.request<T>('GET', path, options);
  }

  post<T>(path: string, options: RequestOptions = {}): Promise<HttpResponse<T>> {
    return this.request<T>('POST', path, options);
  }

  put<T>(path: string, options: RequestOptions = {}): Promise<HttpResponse<T>> {
    return this.request<T>('PUT', path, options);
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<HttpResponse<T>> {
    const url = this.buildUrl(path, options);
    const headers: Record<string, string> = { ...this.headers, ...lowerKeys(options.headers) };
    let body: string | undefined;
    if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      headers['content-type'] ??= 'application/json';
    } else if (options.form) {
      body = new URLSearchParams(options.form).toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }

    const started = performance.now();
    let response: Response;
    let text = '';
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await response.text();
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      this.record(method, url, headers, body, null, new Headers(), null, started, String(err));
      throw timedOut
        ? new TimeoutError(this.opts.provider, this.timeoutMs)
        : new ProviderUnavailableError(
            this.opts.provider,
            null,
            err instanceof Error ? err.message : String(err),
          );
    }

    this.record(method, url, headers, body, response.status, response.headers, text, started, null);

    const throttledFor = this.opts.policy.detectThrottle?.(response.status, text) ?? null;
    if (throttledFor !== null) {
      throw new RateLimitedError(this.opts.provider, throttledFor, this.opts.policy.extractMessage(text));
    }
    if (!response.ok) {
      throw this.toError(response, text);
    }
    return { status: response.status, headers: response.headers, data: parseBody<T>(text, response) };
  }

  private toError(response: Response, text: string): SyncError {
    const { provider, policy } = this.opts;
    const message = policy.extractMessage(text) ?? `HTTP ${response.status}`;
    if (response.status === 429)
      return new RateLimitedError(provider, policy.retryAfterMs(response.headers, text), message);
    if (response.status === 401 || response.status === 403) return new AuthError(provider, message);
    if (response.status === 404) return new NotFoundError(provider, message);
    if (response.status >= 500 || response.status === 408) {
      return new ProviderUnavailableError(provider, response.status, message);
    }
    return new ValidationRejectedError(provider, message);
  }

  private buildUrl(path: string, options: RequestOptions): string {
    const url = options.absolute ? new URL(path) : new URL(joinPath(this.opts.baseUrl, path));
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private record(
    method: string,
    url: string,
    requestHeaders: Record<string, string>,
    requestBody: string | undefined,
    status: number | null,
    responseHeaders: Headers,
    responseBody: string | null,
    started: number,
    error: string | null,
  ): void {
    const current = scope.getStore();
    const resHeaders = Object.fromEntries(responseHeaders.entries());
    this.opts.sink.record({
      connectionId: this.opts.connectionId,
      operationId: current?.operationId ?? null,
      attempt: current?.attempt ?? 1,
      method,
      url: maskUrl(url),
      requestHeaders: maskHeaders(requestHeaders),
      requestBody: maskBody(requestBody ?? null, requestHeaders['content-type'] ?? null),
      status,
      responseHeaders: maskHeaders(resHeaders),
      responseBody: maskBody(responseBody, resHeaders['content-type'] ?? null),
      durationMs: Math.round(performance.now() - started),
      error,
    });
  }
}

function joinPath(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function lowerKeys(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}

function parseBody<T>(text: string, response: Response): T {
  if (!text) return undefined as T;
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('json')) return JSON.parse(text) as T;
  return text as T;
}

/** Retry-After can be seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? fallbackMs : Math.max(0, date - Date.now());
}
