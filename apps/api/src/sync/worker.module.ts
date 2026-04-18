import { Inject, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { CatalogProcessor, MaintenanceProcessor, OrdersProcessor, SchedulerProcessor } from './processors.js';
import { SchedulerService } from './scheduler.service.js';
import { SyncModule } from './sync.module.js';

@Module({
  imports: [SyncModule],
  providers: [OrdersProcessor, CatalogProcessor, MaintenanceProcessor, SchedulerProcessor],
})
export class WorkerModule implements OnApplicationBootstrap {
  constructor(
    private readonly scheduler: SchedulerService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.SCHEDULES_ENABLED) return;
    await this.scheduler.syncSchedules();
  }
}
