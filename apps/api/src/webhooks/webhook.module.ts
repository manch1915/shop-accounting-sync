import { Module } from '@nestjs/common';
import { SyncModule } from '../sync/sync.module.js';
import { WebhookController } from './webhook.controller.js';
import { WebhookService } from './webhook.service.js';

@Module({
  imports: [SyncModule],
  controllers: [WebhookController],
  providers: [WebhookService],
})
export class WebhookModule {}
