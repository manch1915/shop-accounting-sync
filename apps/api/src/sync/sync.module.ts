import { Module } from '@nestjs/common';
import { ConflictService } from './conflict.service.js';
import { FLOW_HANDLERS, type FlowHandler } from './flow.types.js';
import {
  CatalogRefreshFlow,
  PricePushFlow,
  ProductPublishFlow,
  StockPushFlow,
} from './flows/catalog.flows.js';
import { OrderExportFlow } from './flows/order-export.flow.js';
import { PaymentExportFlow } from './flows/payment-export.flow.js';
import { ReconcileFlow } from './flows/reconcile.flow.js';
import { MappingService } from './mapping.service.js';
import { OperationRunner } from './operation.runner.js';
import { OperationService } from './operation.service.js';
import { SchedulerService } from './scheduler.service.js';

const FLOWS = [
  OrderExportFlow,
  PaymentExportFlow,
  StockPushFlow,
  PricePushFlow,
  ProductPublishFlow,
  CatalogRefreshFlow,
  ReconcileFlow,
];

@Module({
  providers: [
    OperationService,
    MappingService,
    ConflictService,
    SchedulerService,
    OperationRunner,
    ...FLOWS,
    { provide: FLOW_HANDLERS, useFactory: (...flows: FlowHandler[]) => flows, inject: FLOWS },
  ],
  exports: [OperationService, MappingService, ConflictService, SchedulerService, OperationRunner],
})
export class SyncModule {}
