import { Redis } from 'ioredis';

export const REDIS = Symbol('REDIS');
export const LIVE_CHANNEL = 'sas:live';

export function createRedis(url: string): Redis {
  // BullMQ workers need maxRetriesPerRequest: null; we use the same options everywhere
  return new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false });
}

export function redisConnectionOptions(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    db: parsed.pathname.length > 1 ? Number(parsed.pathname.slice(1)) : 0,
    maxRetriesPerRequest: null,
  };
}
