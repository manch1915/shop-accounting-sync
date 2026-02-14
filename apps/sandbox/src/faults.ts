import type { Context, MiddlewareHandler } from 'hono';
import type { Random } from './random.js';

export interface FaultSettings {
  /** share of accounting API calls answered with 429 or 503 */
  rate: number;
  slowResponseMs: number;
  injected: { rateLimited: number; unavailable: number; slow: number };
}

export type FaultKind = 'rateLimited' | 'unavailable' | 'slow';

export function createFaultSettings(rate: number, slowResponseMs: number): FaultSettings {
  return { rate, slowResponseMs, injected: { rateLimited: 0, unavailable: 0, slow: 0 } };
}

// slow answers are a quarter as frequent as errors: each one costs the caller a 15 s timeout
export function pickFault(rate: number, random: Random): FaultKind | null {
  if (rate <= 0) return null;
  const roll = random.next();
  if (roll < rate * 0.55) return 'rateLimited';
  if (roll < rate) return 'unavailable';
  if (roll < rate * 1.25) return 'slow';
  return null;
}

export interface FaultResponses {
  rateLimited(c: Context): Response;
  unavailable(c: Context): Response;
}

export function faultInjection(
  settings: FaultSettings,
  responses: FaultResponses,
  random: Random,
): MiddlewareHandler {
  return async (c, next) => {
    const fault = pickFault(settings.rate, random);
    if (fault) settings.injected[fault] += 1;
    if (fault === 'rateLimited') return responses.rateLimited(c);
    if (fault === 'unavailable') return responses.unavailable(c);
    await next();
    // the write has already happened; only the answer is late, like a response lost on the way back
    if (fault === 'slow') await sleep(settings.slowResponseMs);
  };
}

/** fixed window request counter, the way МойСклад and Xero count per account */
export class RequestWindow {
  private windowStart = 0;
  private count = 0;

  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  hit(now = Date.now()): { allowed: boolean; remaining: number; retryAfterMs: number } {
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.count = 0;
    }
    this.count += 1;
    const retryAfterMs = this.windowStart + this.windowMs - now;
    return {
      allowed: this.count <= this.limit,
      remaining: Math.max(0, this.limit - this.count),
      retryAfterMs,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
