import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { OperationRunner } from './operation.runner.js';
import {
  type OperationJob,
  QUEUE_CATALOG,
  QUEUE_MAINTENANCE,
  QUEUE_ORDERS,
  QUEUE_SCHEDULER,
  type ScheduledJob,
} from './queues.js';
import { SchedulerService } from './scheduler.service.js';

// Orders are latency-sensitive and small, catalog jobs are heavy batch calls,
// so they get separate queues and do not wait behind each other.
@Processor(QUEUE_ORDERS, { concurrency: 8 })
export class OrdersProcessor extends WorkerHost {
  constructor(private readonly runner: OperationRunner) {
    super();
  }

  process(job: Job<OperationJob>, token?: string): Promise<unknown> {
    return this.runner.run(job, token);
  }
}

@Processor(QUEUE_CATALOG, { concurrency: 2 })
export class CatalogProcessor extends WorkerHost {
  constructor(private readonly runner: OperationRunner) {
    super();
  }

  process(job: Job<OperationJob>, token?: string): Promise<unknown> {
    return this.runner.run(job, token);
  }
}

@Processor(QUEUE_MAINTENANCE, { concurrency: 2 })
export class MaintenanceProcessor extends WorkerHost {
  constructor(private readonly runner: OperationRunner) {
    super();
  }

  process(job: Job<OperationJob>, token?: string): Promise<unknown> {
    return this.runner.run(job, token);
  }
}

@Processor(QUEUE_SCHEDULER, { concurrency: 1 })
export class SchedulerProcessor extends WorkerHost {
  constructor(private readonly scheduler: SchedulerService) {
    super();
  }

  process(job: Job<ScheduledJob>): Promise<unknown> {
    return this.scheduler.fire(job.data);
  }
}
