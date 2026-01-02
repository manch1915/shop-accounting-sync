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

const MULTI_SCRIPT = `
local now = tonumber(ARGV[1])
local member = ARGV[2]
local wait = 0
for i, key in ipairs(KEYS) do
  local window = tonumber(ARGV[1 + i * 2])
  local limit = tonumber(ARGV[2 + i * 2])
  redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
  if redis.call('ZCARD', key) >= limit then
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    wait = math.max(wait, tonumber(oldest[2]) + window - now)
  end
end
if wait > 0 then return wait end
for i, key in ipairs(KEYS) do
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, tonumber(ARGV[1 + i * 2]))
end
return 0
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

  /**
   * All-or-nothing over several windows: a slot is taken in every key only when every key has
   * room, so a request rejected by one limit does not eat into the others.
   */
  async acquireAll(entries: Array<{ key: string; rule: RateLimit }>): Promise<number> {
    const now = Date.now();
    const member = `${now}-${process.pid}-${this.seq++}`;
    const args = entries.flatMap(({ rule }) => [rule.windowMs, rule.limit]);
    const wait = await this.redis.eval(
      MULTI_SCRIPT,
      entries.length,
      ...entries.map((e) => `sas:rl:${e.key}`),
      now,
      member,
      ...args,
    );
    return Number(wait);
  }

  async usage(key: string, rule: RateLimit): Promise<number> {
    const redisKey = `sas:rl:${key}`;
    await this.redis.zremrangebyscore(redisKey, 0, Date.now() - rule.windowMs);
    return this.redis.zcard(redisKey);
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(`sas:rl:${key}`);
  }
}
