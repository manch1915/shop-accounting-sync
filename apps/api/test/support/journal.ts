import type { Provider } from '@sas/shared';
import { type ErrorPolicy, type ExchangeRecord, HttpClient } from '../../src/connectors/http/http-client.js';

/** HttpClient that keeps journal records in memory, for connector tests. */
export function testHttp(provider: Provider, baseUrl: string, policy: ErrorPolicy) {
  const records: ExchangeRecord[] = [];
  const http = new HttpClient({
    provider,
    connectionId: 'conn_test',
    baseUrl,
    timeoutMs: 2000,
    sink: { record: (r) => records.push(r) },
    policy,
  });
  return { http, records };
}
