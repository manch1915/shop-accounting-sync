import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { IntegrationFlags, OperationType } from '@sas/shared';
import { DelayedError, type Job, type Queue, UnrecoverableError } from 'bullmq';
import { AlertService } from '../alerts/alert.service.js';
import { ConnectorService } from '../connectors/connector.service.js';
import { withJournalScope } from '../connectors/http/http-client.js';
import { MappingError, RateLimitedError, type SyncError, toSyncError } from '../domain/errors.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../infra/prisma.service.js';
import { ExchangeJournal } from '../journal/exchange-journal.service.js';
import { ConflictService } from './conflict.service.js';
import {
  FLOW_HANDLERS,
  type FlowContext,
  type FlowHandler,
  type IntegrationSettings,
  type IntegrationWithConnections,
} from './flow.types.js';
import { OperationService } from './operation.service.js';
import { BACKOFF, type OperationJob, QUEUE_DEAD } from './queues.js';

type LoadedOperation = Prisma.OperationGetPayload<{
  include: { integration: { include: { store: true; accounting: true } } };
}>;

@Injectable()
export class OperationRunner {
  private readonly handlers: Map<OperationType, FlowHandler>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationService,
    private readonly connectors: ConnectorService,
    private readonly conflicts: ConflictService,
    private readonly alerts: AlertService,
    private readonly journal: ExchangeJournal,
    @Inject(FLOW_HANDLERS) handlers: FlowHandler[],
    @InjectQueue(QUEUE_DEAD) private readonly deadLetter: Queue,
  ) {
    this.handlers = new Map(handlers.map((h) => [h.type, h]));
  }

  async run(job: Job<OperationJob>, token?: string): Promise<unknown> {
    const op = await this.prisma.operation.findUnique({
      where: { id: job.data.operationId },
      include: { integration: { include: { store: true, accounting: true } } },
    });
    if (!op) return null;
    const handler = this.handlers.get(op.type as OperationType);
    if (!handler) throw new UnrecoverableError(`No handler for ${op.type}`);

    // Claim the operation atomically. A second job for the same operation (manual retry racing an
    // automatic one, a stale job after a restart) finds it already running or finished and stops,
    // so an order or payment is never sent twice in parallel.
    const attempt = op.attempts + 1;
    const claimed = await this.prisma.operation.updateMany({
      where: { id: op.id, status: { in: ['queued', 'retrying'] }, attempts: op.attempts },
      data: {
        status: 'running',
        attempts: attempt,
        startedAt: op.startedAt ?? new Date(),
        nextRetryAt: null,
      },
    });
    if (claimed.count === 0) return null;

    const started = Date.now();
    await this.operations.update(
      op.id,
      {},
      attempt > 1 ? { level: 'info', message: `Attempt ${attempt} of ${op.maxAttempts}` } : undefined,
    );

    try {
      const ctx = this.context(op);
      const result = await withJournalScope(op.id, attempt, () => handler.run(ctx));
      await this.journal.flush();
      await this.operations.update(
        op.id,
        {
          status: result.skipped ? 'skipped' : 'succeeded',
          result: result as Prisma.InputJsonValue,
          durationMs: Date.now() - started,
          finishedAt: new Date(),
          errorCode: null,
          errorParams: Prisma.DbNull,
          errorDetail: null,
        },
        { level: 'info', message: result.skipped ?? 'Done' },
      );
      await this.markHealthy(op.integration);
      return result;
    } catch (raw) {
      await this.journal.flush();
      return this.fail(job, token, op, attempt, Date.now() - started, toSyncError(raw));
    }
  }

  private async fail(
    job: Job<OperationJob>,
    token: string | undefined,
    op: LoadedOperation,
    attempt: number,
    durationMs: number,
    err: SyncError,
  ): Promise<unknown> {
    const error = {
      errorCode: err.code,
      errorParams: err.params as Prisma.InputJsonValue,
      errorDetail: err.detail ?? err.message,
      durationMs,
    };

    if (err instanceof MappingError) {
      const conflictId = await this.conflicts.open(op.integrationId, err);
      await this.operations.update(
        op.id,
        { ...error, status: 'blocked', conflict: { connect: { id: conflictId } } },
        { level: 'warn', message: `On hold: ${err.message}` },
      );
      // the job completes; ConflictService re-queues the operation once someone adds the mapping
      return { blocked: conflictId };
    }

    if (err instanceof RateLimitedError) {
      const until = Date.now() + err.retryAfterMs;
      // waiting for a provider limit is not a failed attempt
      await this.operations.update(
        op.id,
        { ...error, status: 'retrying', attempts: attempt - 1, nextRetryAt: new Date(until) },
        { level: 'warn', message: `Rate limited, continuing in ${Math.ceil(err.retryAfterMs / 1000)} s` },
      );
      await job.moveToDelayed(until, token);
      throw new DelayedError();
    }

    if (err.code === 'not_found') {
      await this.operations.update(
        op.id,
        { ...error, status: 'skipped', finishedAt: new Date() },
        { level: 'warn', message: err.message },
      );
      return { skipped: err.message };
    }

    if (err.retryable && attempt < op.maxAttempts) {
      const delay = BACKOFF.delay * 2 ** (attempt - 1);
      await this.operations.update(
        op.id,
        { ...error, status: 'retrying', nextRetryAt: new Date(Date.now() + delay) },
        { level: 'warn', message: `${err.message}. Retrying in about ${Math.round(delay / 1000)} s` },
      );
      throw err;
    }

    await this.operations.update(
      op.id,
      { ...error, status: 'dead', finishedAt: new Date() },
      {
        level: 'error',
        message: err.retryable ? `Gave up after ${attempt} attempts: ${err.message}` : err.message,
      },
    );
    await this.deadLetter.add(
      op.type,
      { operationId: op.id, errorCode: err.code },
      { jobId: `${op.id}-${attempt}` },
    );
    await this.reportFailure(op, err);
    throw new UnrecoverableError(err.message);
  }

  private async reportFailure(op: LoadedOperation, err: SyncError): Promise<void> {
    const { integration } = op;
    if (err.code === 'auth_failed') {
      const connection =
        err.params.provider === integration.store.provider ? integration.store : integration.accounting;
      await this.prisma.connection.update({
        where: { id: connection.id },
        data: { status: 'error', statusReason: err.detail ?? err.message },
      });
      await this.alerts.raise(integration.workspaceId, {
        severity: 'critical',
        title: `${connection.name}: access rejected`,
        body: 'The key was revoked or the app was removed. Syncing for this connection is stopped until it is reconnected.',
        dedupeKey: `auth:${connection.id}`,
      });
      return;
    }
    await this.alerts.raise(integration.workspaceId, {
      severity: 'critical',
      title: `${integration.name}: ${op.subject} failed`,
      body: `${err.message}. It is in failed jobs with the full request and response, ready to retry.`,
      dedupeKey: `dead:${op.integrationId}:${err.code}`,
    });
  }

  private async markHealthy(integration: IntegrationWithConnections): Promise<void> {
    const now = new Date();
    await this.prisma.connection.updateMany({
      where: { id: { in: [integration.store.id, integration.accounting.id] } },
      data: { lastSyncAt: now },
    });
    await this.prisma.connection.updateMany({
      where: { id: { in: [integration.store.id, integration.accounting.id] }, status: 'degraded' },
      data: { status: 'active', statusReason: null },
    });
  }

  private context(op: LoadedOperation): FlowContext {
    const { integration } = op;
    return {
      operation: op,
      integration,
      flags: integration.flags as unknown as IntegrationFlags,
      settings: (integration.settings ?? {}) as IntegrationSettings,
      store: this.connectors.store(integration.store),
      accounting: this.connectors.accounting(integration.accounting),
      log: (level, message) => this.operations.event(op.id, level, message),
    };
  }
}
