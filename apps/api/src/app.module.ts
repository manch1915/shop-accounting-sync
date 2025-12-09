import { type DynamicModule, Module } from '@nestjs/common';
import type { AppConfig } from './config/env.js';
import { CoreModule } from './core.module.js';
import { PanelModule } from './panel/panel.module.js';
import { WorkerModule } from './sync/worker.module.js';
import { WebhookModule } from './webhooks/webhook.module.js';

@Module({})
export class AppModule {
  // One image, three roles: the HTTP side (panel + webhooks), queue workers, or both for local dev.
  static forRole(role: AppConfig['APP_ROLE']): DynamicModule {
    const http = role === 'api' || role === 'all' ? [PanelModule, WebhookModule] : [];
    const worker = role === 'worker' || role === 'all' ? [WorkerModule] : [];
    return { module: AppModule, imports: [CoreModule, ...http, ...worker] };
  }
}
