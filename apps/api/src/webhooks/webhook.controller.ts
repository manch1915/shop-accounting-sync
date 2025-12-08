import { Controller, HttpCode, Param, Post, type RawBodyRequest, Req } from '@nestjs/common';
import type { Request } from 'express';
import { type WebhookOutcome, WebhookService } from './webhook.service.js';

@Controller('webhooks')
export class WebhookController {
  constructor(private readonly webhooks: WebhookService) {}

  // Providers give us 1.5 s (МойСклад) to 5 s (Shopify, Xero): verify, store, queue, answer.
  @Post(':connectionId')
  @HttpCode(200)
  receive(
    @Param('connectionId') connectionId: string,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<WebhookOutcome> {
    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      headers[key.toLowerCase()] = Array.isArray(value) ? value.join(',') : value;
    }
    const query: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(req.query)) {
      if (typeof value === 'string') query[key] = value;
    }
    return this.webhooks.handle(connectionId, { headers, query, rawBody: req.rawBody ?? Buffer.alloc(0) });
  }
}
