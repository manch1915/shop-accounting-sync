import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ROLE: z.enum(['api', 'worker', 'all']).default('all'),
  API_PORT: z.coerce.number().int().default(4000),
  PUBLIC_API_URL: z.url().default('http://localhost:4000'),
  WEB_ORIGIN: z.url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  /** separates queues of several deployments (or a test run) sharing one Redis */
  QUEUE_PREFIX: z
    .string()
    .regex(/^[\w-]+$/)
    .default('sas'),
  ENCRYPTION_KEY: z.string().min(40, 'ENCRYPTION_KEY must be 32 bytes in base64'),
  SESSION_SECRET: z.string().min(32),
  /** off in tests, so a test worker never touches other integrations in a shared database */
  SCHEDULES_ENABLED: z
    .enum(['true', 'false', '1', '0'])
    .default('true')
    .transform((v) => v === 'true' || v === '1'),
  DEMO_ENABLED: bool,
  DEMO_ALLOW_ACTIONS: bool,
  TELEGRAM_BOT_TOKEN: z.string().optional().default(''),
  TELEGRAM_CHAT_ID: z.string().optional().default(''),
});

export type AppConfig = z.infer<typeof schema>;
export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  loadDotenv({ path: ['.env', '../../.env'], quiet: true });
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}
