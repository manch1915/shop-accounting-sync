import type { ErrorCode, OperationDto, OperationStatus, OperationType } from '@sas/shared';
import type { Operation } from '../generated/prisma/client.js';

export type OperationWithIntegration = Operation & { integration: { name: string } };

function urlFrom(value: unknown): string | null {
  if (value && typeof value === 'object' && 'url' in value && typeof value.url === 'string') return value.url;
  return null;
}

export function toOperationDto(op: OperationWithIntegration): OperationDto {
  return {
    id: op.id,
    integrationId: op.integrationId,
    integrationName: op.integration.name,
    type: op.type as OperationType,
    status: op.status as OperationStatus,
    subject: op.subject,
    subjectUrl: urlFrom(op.result) ?? urlFrom(op.payload),
    attempts: op.attempts,
    maxAttempts: op.maxAttempts,
    durationMs: op.durationMs,
    errorCode: (op.errorCode as ErrorCode | null) ?? null,
    errorParams: (op.errorParams as Record<string, string | number> | null) ?? null,
    errorDetail: op.errorDetail,
    nextRetryAt: op.nextRetryAt?.toISOString() ?? null,
    createdAt: op.createdAt.toISOString(),
    updatedAt: op.updatedAt.toISOString(),
  };
}
