import type { Provider } from '@sas/shared';
import type { Redis } from 'ioredis';

export interface RateLimit {
  limit: number;
  windowMs: number;
}

// Conservative client-side budgets, a bit under what each provider allows.
// МойСклад user tokens: 15 req / 3 s since 01.09.2026 (11 from 01.12.2026), so we stay at 10.
// Xero: 60 req / min per tenant. Shopify: leaky bucket, ~2 req/s keeps standard plans happy.
export const PROVIDER_LIMITS: Record<Provider, RateLimit> = {
  moysklad: { limit: 10, windowMs: 3_000 },
  xero: { limit: 55, windowMs: 60_000 },
  shopify: { limit: 4, windowMs: 2_000 },
  woocommerce: { limit: 20, windowMs: 2_000 },
};

// Sliding window log. Returns 0 when a slot was taken, otherwise ms until the oldest entry expires.
const SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  return 0
end
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
return tonumber(oldest[2]) + window - now
`;

export class RedisRateLimiter {
  private seq = 0;

  constructor(private readonly redis: Redis) {}

  /** ms to wait before the next request is allowed; 0 means the slot is taken */
  async acquire(key: string, rule: RateLimit): Promise<number> {
    const member = `${Date.now()}-${process.pid}-${this.seq++}`;
    const wait = await this.redis.eval(
      SCRIPT,
      1,
      `sas:rl:${key}`,
      Date.now(),
      rule.windowMs,
      rule.limit,
      member,
    );
    return Number(wait);
  }

  async usage(key: string, rule: RateLimit): Promise<number> {
    const redisKey = `sas:rl:${key}`;
    await this.redis.zremrangebyscore(redisKey, 0, Date.now() - rule.windowMs);
    return this.redis.zcard(redisKey);
  }
}
