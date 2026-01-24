import 'server-only';
import type { IntegrationDto } from '@sas/shared';
import type { RouteMap } from '@/components/operations';
import { api } from './server';

export async function getIntegrations(): Promise<IntegrationDto[]> {
  return api<IntegrationDto[]>('/api/integrations');
}

export function routeMap(integrations: IntegrationDto[]): RouteMap {
  return Object.fromEntries(
    integrations.map((i) => [
      i.id,
      { store: i.store.provider, accounting: i.accounting.provider, name: i.name },
    ]),
  );
}
