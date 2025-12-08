import { Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConnectorService } from '../connectors/connector.service.js';
import type { IncomingWebhook, WebhookEvent } from '../domain/models.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../infra/prisma.service.js';
import { enqueueOrder } from '../sync/flows/order-export.flow.js';
import { enqueuePayment } from '../sync/flows/payment-export.flow.js';
import { OperationService } from '../sync/operation.service.js';
import { SchedulerService } from '../sync/scheduler.service.js';

export interface WebhookOutcome {
  received: number;
  duplicates: number;
  queued: number;
}

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorService,
    private readonly operations: OperationService,
    private readonly scheduler: SchedulerService,
  ) {}

  async handle(connectionId: string, webhook: IncomingWebhook): Promise<WebhookOutcome> {
    const connection = await this.prisma.connection.findUnique({
      where: { id: connectionId },
      include: { storeIntegrations: true, accountingIntegrations: true },
    });
    if (!connection) throw new NotFoundException();

    const secret = this.connectors.webhookSecret(connection);
    const connector = this.connectors.webhookAware(connection);
    if (!secret || !connector.verifyWebhook(webhook, secret)) {
      this.logger.warn(`Rejected webhook with a bad signature for ${connection.name}`);
      throw new UnauthorizedException();
    }

    const outcome: WebhookOutcome = { received: 0, duplicates: 0, queued: 0 };
    for (const event of connector.parseWebhook(webhook)) {
      outcome.received += 1;
      if (event.topic === 'ping') continue;
      if (!(await this.remember(connectionId, event))) {
        outcome.duplicates += 1;
        continue;
      }
      for (const integration of connection.storeIntegrations) {
        outcome.queued += await this.routeStoreEvent(integration.id, event);
      }
      for (const integration of connection.accountingIntegrations) {
        outcome.queued += await this.routeAccountingEvent(integration.id, event);
      }
    }
    return outcome;
  }

  /** false when this delivery was already processed (providers retry and sometimes double-send) */
  private async remember(connectionId: string, event: WebhookEvent): Promise<boolean> {
    try {
      await this.prisma.webhookReceipt.create({
        data: { connectionId, deliveryId: event.deliveryId, topic: event.topic },
      });
      return true;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return false;
      throw err;
    }
  }

  private async routeStoreEvent(integrationId: string, event: WebhookEvent): Promise<number> {
    const orderId = event.entityId;
    switch (event.topic) {
      case 'order.created':
        return orderId ? count(await enqueueOrder(this.operations, integrationId, orderId)) : 0;
      case 'order.updated':
      case 'order.paid': {
        if (!orderId) return 0;
        const exported = await this.prisma.entityLink.findUnique({
          where: { integrationId_entity_storeId: { integrationId, entity: 'order', storeId: orderId } },
        });
        return count(
          exported
            ? await enqueuePayment(this.operations, integrationId, orderId)
            : await enqueueOrder(this.operations, integrationId, orderId),
        );
      }
      case 'product.created':
      case 'product.updated':
        return count(await this.scheduler.fire({ integrationId, type: 'catalog.refresh' }, 5 * 60_000));
      default:
        return 0;
    }
  }

  private async routeAccountingEvent(integrationId: string, event: WebhookEvent): Promise<number> {
    switch (event.topic) {
      case 'stock.changed':
        return count(await this.scheduler.fire({ integrationId, type: 'stock.push' }));
      case 'product.created':
      case 'product.updated':
        return count(await this.scheduler.fire({ integrationId, type: 'price.push' }, 5 * 60_000));
      default:
        return 0;
    }
  }
}

function count(result: unknown): number {
  return result && typeof result === 'object' && 'created' in result && result.created ? 1 : 0;
}
