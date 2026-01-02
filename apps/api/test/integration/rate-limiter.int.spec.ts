import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisRateLimiter } from '../../src/infra/rate-limiter.js';

const url = process.env.REDIS_URL ?? 'redis://localhost:6380';
let redis: Redis;
let limiter: RedisRateLimiter;
const ns = `t${Date.now()}`;

beforeAll(() => {
  redis = new Redis(url, { maxRetriesPerRequest: 1 });
  limiter = new RedisRateLimiter(redis);
});
afterAll(async () => {
  const keys = await redis.keys(`sas:rl:${ns}:*`);
  if (keys.length) await redis.del(...keys);
  await redis.quit();
});

describe('RedisRateLimiter (needs Redis)', () => {
  it('lets the limit through and then asks to wait', async () => {
    const rule = { limit: 3, windowMs: 10_000 };
    const waits = [];
    for (let i = 0; i < 4; i++) waits.push(await limiter.acquire(`${ns}:single`, rule));
    expect(waits.slice(0, 3)).toEqual([0, 0, 0]);
    expect(waits[3]).toBeGreaterThan(0);
  });

  it('takes slots in every key only when all of them have room', async () => {
    const tight = { key: `${ns}:tight`, rule: { limit: 1, windowMs: 10_000 } };
    const wide = { key: `${ns}:wide`, rule: { limit: 100, windowMs: 10_000 } };
    expect(await limiter.acquireAll([tight, wide])).toBe(0);
    expect(await limiter.acquireAll([tight, wide])).toBeGreaterThan(0);
    // the rejected request must not have been counted against the wide key
    expect(await limiter.usage(wide.key, wide.rule)).toBe(1);
  });
});
