import { describe, expect, it } from 'vitest';
import { AuthError, RateLimitedError, TimeoutError, ValidationRejectedError } from '../../domain/errors.js';
import { type ExchangeRecord, HttpClient, parseRetryAfter, withJournalScope } from './http-client.js';

function client(fetchImpl: typeof fetch, records: ExchangeRecord[] = []) {
  return new HttpClient({
    provider: 'woocommerce',
    connectionId: 'conn_1',
    baseUrl: 'https://shop.test/wp-json/wc/v3/',
    headers: { authorization: 'Basic Y2tfMTIzOmNzXzQ1Ng==' },
    timeoutMs: 50,
    sink: { record: (r) => records.push(r) },
    policy: {
      retryAfterMs: (h) => parseRetryAfter(h.get('retry-after'), 1000),
      extractMessage: (body) => {
        try {
          return (JSON.parse(body) as { message?: string }).message ?? null;
        } catch {
          return null;
        }
      },
    },
    fetchImpl,
  });
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('HttpClient', () => {
  it('records a masked exchange tied to the current operation', async () => {
    const records: ExchangeRecord[] = [];
    const http = client(async () => json(200, { id: 7 }), records);
    const res = await withJournalScope('op_1', 2, () => http.get<{ id: number }>('/orders/7'));
    expect(res.data.id).toBe(7);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ operationId: 'op_1', attempt: 2, status: 200, method: 'GET' });
    expect(records[0]?.url).toBe('https://shop.test/wp-json/wc/v3/orders/7');
    expect(records[0]?.requestHeaders.authorization).not.toContain('Y2tfMTIz');
  });

  it('maps 429 to RateLimitedError with the provider delay', async () => {
    const http = client(async () => json(429, { message: 'slow down' }, { 'retry-after': '3' }));
    const err = await http.get('/orders').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterMs).toBe(3000);
  });

  it('maps 401 to AuthError and 400 to a validation error with the provider message', async () => {
    await expect(client(async () => json(401, {})).get('/x')).rejects.toBeInstanceOf(AuthError);
    const err = await client(async () => json(400, { message: 'Invalid SKU' }))
      .post('/x', { json: {} })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationRejectedError);
    expect((err as ValidationRejectedError).detail).toBe('Invalid SKU');
  });

  it('turns a hanging request into TimeoutError and still logs it', async () => {
    const records: ExchangeRecord[] = [];
    const hang: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    await expect(client(hang, records).get('/slow')).rejects.toBeInstanceOf(TimeoutError);
    expect(records[0]?.status).toBeNull();
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds and falls back when missing', () => {
    expect(parseRetryAfter('2', 500)).toBe(2000);
    expect(parseRetryAfter(null, 500)).toBe(500);
  });
});
