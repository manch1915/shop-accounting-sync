import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from '../auth/auth.controller.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { SyncModule } from '../sync/sync.module.js';
import { HealthController } from './health.controller.js';
import { LiveController } from './live.controller.js';
import { PanelController } from './panel.controller.js';
import { PanelQueryService } from './panel-query.service.js';

@Module({
  imports: [SyncModule],
  controllers: [AuthController, PanelController, LiveController, HealthController],
  providers: [PanelQueryService, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class PanelModule {}
