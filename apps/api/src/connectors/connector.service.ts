import { Inject, Injectable } from '@nestjs/common';
import type { Provider } from '@sas/shared';
import type { Redis } from 'ioredis';
import type { AccountingConnector, ConnectorContext, StoreConnector } from '../domain/connectors.js';
import type { Connection } from '../generated/prisma/client.js';
import { PrismaService } from '../infra/prisma.service.js';
import { PROVIDER_LIMITS, RedisRateLimiter } from '../infra/rate-limiter.js';
import { REDIS } from '../infra/redis.js';
import { ExchangeJournal } from '../journal/exchange-journal.service.js';
import { CredentialCipher } from '../security/credential-cipher.js';
import { HttpClient } from './http/http-client.js';
import { accountingFactory, anyFactory, errorPolicy, storeFactory } from './registry.js';

@Injectable()
export class ConnectorService {
  private readonly limiter: RedisRateLimiter;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: CredentialCipher,
    private readonly journal: ExchangeJournal,
    @Inject(REDIS) redis: Redis,
  ) {
    this.limiter = new RedisRateLimiter(redis);
  }

  store(connection: Connection): StoreConnector {
    return storeFactory(connection.provider).create(this.context(connection));
  }

  accounting(connection: Connection): AccountingConnector {
    return accountingFactory(connection.provider).create(this.context(connection));
  }

  webhookAware(connection: Connection) {
    const factory = anyFactory(connection.provider);
    return factory.create(this.context(connection));
  }

  webhookSecret(connection: Connection): string | null {
    return connection.webhookSecret ? this.cipher.decrypt(connection.webhookSecret) : null;
  }

  async rateUsage(connection: Connection): Promise<{ used: number; limit: number; windowSec: number }> {
    const rule = PROVIDER_LIMITS[connection.provider as Provider];
    const used = await this.limiter.usage(connection.id, rule);
    return { used, limit: rule.limit, windowSec: rule.windowMs / 1000 };
  }

  private context(connection: Connection): ConnectorContext {
    const provider = connection.provider as Provider;
    const http = new HttpClient({
      provider,
      connectionId: connection.id,
      baseUrl: connection.baseUrl,
      sink: this.journal,
      policy: errorPolicy(provider),
      limiter: () => this.limiter.acquire(connection.id, PROVIDER_LIMITS[provider]),
    });
    return {
      connectionId: connection.id,
      baseUrl: connection.baseUrl,
      credentials: this.cipher.decryptJson(connection.credentials),
      settings: (connection.settings ?? {}) as Record<string, unknown>,
      http,
      onCredentialsRefreshed: async (credentials, expiresAt) => {
        await this.prisma.connection.update({
          where: { id: connection.id },
          data: { credentials: this.cipher.encryptJson(credentials), tokenExpiresAt: expiresAt },
        });
      },
    };
  }
}
