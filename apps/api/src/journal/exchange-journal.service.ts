import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { ExchangeRecord, ExchangeSink } from '../connectors/http/http-client.js';
import { PrismaService } from '../infra/prisma.service.js';

const FLUSH_MS = 300;

/** Buffers HTTP exchanges and writes them in batches, so logging never slows a sync down. */
@Injectable()
export class ExchangeJournal implements ExchangeSink, OnModuleDestroy {
  private readonly logger = new Logger(ExchangeJournal.name);
  private buffer: ExchangeRecord[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  record(exchange: ExchangeRecord): void {
    this.buffer.push(exchange);
    this.timer ??= setTimeout(() => void this.flush(), FLUSH_MS);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = this.buffer;
    this.buffer = [];
    if (batch.length === 0) return;
    try {
      await this.prisma.httpExchange.createMany({
        data: batch.map((e) => ({
          connectionId: e.connectionId,
          operationId: e.operationId,
          attempt: e.attempt,
          method: e.method,
          url: e.url,
          requestHeaders: e.requestHeaders,
          requestBody: e.requestBody,
          status: e.status,
          responseHeaders: e.responseHeaders,
          responseBody: e.responseBody,
          durationMs: e.durationMs,
          error: e.error,
        })),
      });
    } catch (err) {
      this.logger.error(`Could not store ${batch.length} HTTP exchanges: ${String(err)}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.flush();
  }
}
