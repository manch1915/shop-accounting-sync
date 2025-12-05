import { Module, type OnApplicationBootstrap } from '@nestjs/common';
import { CatalogProcessor, MaintenanceProcessor, OrdersProcessor, SchedulerProcessor } from './processors.js';
import { SchedulerService } from './scheduler.service.js';
import { SyncModule } from './sync.module.js';

@Module({
  imports: [SyncModule],
  providers: [OrdersProcessor, CatalogProcessor, MaintenanceProcessor, SchedulerProcessor],
})
export class WorkerModule implements OnApplicationBootstrap {
  constructor(private readonly scheduler: SchedulerService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.scheduler.syncSchedules();
  }
}
