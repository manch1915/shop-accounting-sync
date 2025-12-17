import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { LiveEvent, OperationStatus, OperationType } from '@sas/shared';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../infra/prisma.service.js';
import { LIVE_CHANNEL, REDIS } from '../infra/redis.js';
import { type OperationWithIntegration, toOperationDto } from '../journal/operation.mapper.js';
import {
  BACKOFF,
  MAX_ATTEMPTS,
  type OperationJob,
  QUEUE_CATALOG,
  QUEUE_MAINTENANCE,
  QUEUE_ORDERS,
  queueFor,
} from './queues.js';

export interface EnqueueInput {
  integrationId: string;
  type: OperationType;
  subject: string;
  subjectRef?: string | null;
  /** same key = same logical operation; repeats are dropped */
  dedupeKey: string;
  payload?: Record<string, unknown>;
  delayMs?: number;
}

export interface EnqueueResult {
  operationId: string;
  created: boolean;
  reason?: 'in_progress' | 'already_done' | 'needs_manual_retry';
}

const ACTIVE: OperationStatus[] = ['queued', 'running', 'retrying', 'blocked'];

@Injectable()
export class OperationService {
  private readonly queues: Record<string, Queue>;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @InjectQueue(QUEUE_ORDERS) orders: Queue,
    @InjectQueue(QUEUE_CATALOG) catalog: Queue,
    @InjectQueue(QUEUE_MAINTENANCE) maintenance: Queue,
  ) {
    this.queues = { [QUEUE_ORDERS]: orders, [QUEUE_CATALOG]: catalog, [QUEUE_MAINTENANCE]: maintenance };
  }

  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    const existing = await this.prisma.operation.findUnique({ where: { dedupeKey: input.dedupeKey } });
    if (existing) return this.handleRepeat(existing.id, existing.status as OperationStatus, input);

    try {
      const op = await this.prisma.operation.create({
        data: {
          integrationId: input.integrationId,
          type: input.type,
          subject: input.subject,
          subjectRef: input.subjectRef ?? null,
          dedupeKey: input.dedupeKey,
          payload: (input.payload ?? {}) as Prisma.InputJsonValue,
          maxAttempts: MAX_ATTEMPTS,
        },
        include: { integration: { select: { name: true, workspaceId: true } } },
      });
      await this.addJob(op.id, input.type, op.id, input.delayMs);
      await this.publish(op);
      return { operationId: op.id, created: true };
    } catch (err) {
      // two deliveries of the same event raced each other; the other one won
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const winner = await this.prisma.operation.findUniqueOrThrow({
          where: { dedupeKey: input.dedupeKey },
        });
        return { operationId: winner.id, created: false, reason: 'in_progress' };
      }
      throw err;
    }
  }

  /** Manual retry or automatic resume after a conflict was resolved. */
  async requeue(operationId: string, reason: string): Promise<void> {
    const op = await this.prisma.operation.update({
      where: { id: operationId },
      data: {
        status: 'queued',
        attempts: 0,
        errorCode: null,
        errorParams: Prisma.DbNull,
        errorDetail: null,
        nextRetryAt: null,
        conflictId: null,
        finishedAt: null,
        events: { create: { level: 'info', message: reason } },
      },
      include: { integration: { select: { name: true, workspaceId: true } } },
    });
    await this.addJob(op.id, op.type as OperationType, `${op.id}-r${Date.now()}`);
    await this.publish(op);
  }

  async update(
    operationId: string,
    data: Prisma.OperationUpdateInput,
    event?: { level: 'info' | 'warn' | 'error'; message: string },
  ): Promise<OperationWithIntegration> {
    const op = await this.prisma.operation.update({
      where: { id: operationId },
      data: event ? { ...data, events: { create: event } } : data,
      include: { integration: { select: { name: true, workspaceId: true } } },
    });
    await this.publish(op);
    return op;
  }

  async event(operationId: string, level: 'info' | 'warn' | 'error', message: string): Promise<void> {
    await this.prisma.operationEvent.create({ data: { operationId, level, message } });
  }

  async publish(op: OperationWithIntegration): Promise<void> {
    const workspaceId = op.integration.workspaceId;
    if (!workspaceId) return;
    const event: LiveEvent = { workspaceId, type: 'operation', operation: toOperationDto(op) };
    await this.redis.publish(LIVE_CHANNEL, JSON.stringify(event));
  }

  private async handleRepeat(
    id: string,
    status: OperationStatus,
    input: EnqueueInput,
  ): Promise<EnqueueResult> {
    if (ACTIVE.includes(status)) return { operationId: id, created: false, reason: 'in_progress' };
    if (status === 'succeeded') {
      await this.event(id, 'info', 'Repeated event ignored, this was already synced');
      return { operationId: id, created: false, reason: 'already_done' };
    }
    if (status === 'dead') return { operationId: id, created: false, reason: 'needs_manual_retry' };
    // skipped earlier (e.g. order was not paid yet), a new event may change that
    await this.prisma.operation.update({
      where: { id },
      data: { payload: (input.payload ?? {}) as Prisma.InputJsonValue },
    });
    await this.requeue(id, 'New event received, running again');
    return { operationId: id, created: true };
  }

  private async addJob(
    operationId: string,
    type: OperationType,
    jobId: string,
    delay?: number,
  ): Promise<void> {
    const queue = this.queues[queueFor(type)];
    if (!queue) throw new Error(`No queue for ${type}`);
    const data: OperationJob = { operationId };
    await queue.add(type, data, {
      jobId,
      delay,
      attempts: MAX_ATTEMPTS,
      backoff: BACKOFF,
      removeOnComplete: { age: 3600, count: 2000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    });
  }
}
