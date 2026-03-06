import { BullModule } from '@nestjs/bullmq';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AlertService } from './alerts/alert.service.js';
import { APP_CONFIG, type AppConfig, loadConfig } from './config/env.js';
import { ConnectorService } from './connectors/connector.service.js';
import { PrismaService } from './infra/prisma.service.js';
import { createRedis, REDIS, redisConnectionOptions } from './infra/redis.js';
import { ExchangeJournal } from './journal/exchange-journal.service.js';
import { CredentialCipher } from './security/credential-cipher.js';
import { ALL_QUEUES } from './sync/queues.js';

const config = loadConfig();

@Global()
@Module({
  imports: [
    BullModule.forRoot({ connection: redisConnectionOptions(config.REDIS_URL), prefix: config.QUEUE_PREFIX }),
    BullModule.registerQueue(...ALL_QUEUES.map((name) => ({ name }))),
  ],
  providers: [
    { provide: APP_CONFIG, useValue: config },
    { provide: REDIS, useFactory: (c: AppConfig) => createRedis(c.REDIS_URL), inject: [APP_CONFIG] },
    {
      provide: CredentialCipher,
      useFactory: (c: AppConfig) => new CredentialCipher(c.ENCRYPTION_KEY),
      inject: [APP_CONFIG],
    },
    PrismaService,
    ExchangeJournal,
    ConnectorService,
    AlertService,
  ],
  exports: [
    APP_CONFIG,
    REDIS,
    CredentialCipher,
    PrismaService,
    ExchangeJournal,
    ConnectorService,
    AlertService,
    BullModule,
  ],
})
export class CoreModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}
