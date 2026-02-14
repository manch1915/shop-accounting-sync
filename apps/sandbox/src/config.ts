export interface SandboxConfig {
  port: number;
  /** base URL the sandbox is reachable at, used in МойСклад hrefs inside webhooks */
  publicUrl: string;
  token: string;
  webhookTarget: string;
  generator: boolean;
  generatorMinSec: number;
  generatorMaxSec: number;
  faultRate: number;
  /** longer than the API client's 15 s timeout, so the caller gives up while the write went through */
  slowResponseMs: number;
}

function number(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
}

export function loadConfig(): SandboxConfig {
  const port = number('SANDBOX_PORT', 4010);
  const min = number('GENERATOR_MIN_SEC', 20);
  const max = number('GENERATOR_MAX_SEC', 70);
  return {
    port,
    publicUrl: (process.env.SANDBOX_PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    token: process.env.SANDBOX_TOKEN || 'sandbox-demo-token',
    webhookTarget: (process.env.SANDBOX_WEBHOOK_TARGET || 'http://localhost:4000').replace(/\/+$/, ''),
    generator: process.env.DEMO_GENERATOR === 'true',
    generatorMinSec: Math.max(1, Math.min(min, max)),
    generatorMaxSec: Math.max(1, min, max),
    faultRate: Math.min(1, Math.max(0, number('SANDBOX_FAULT_RATE', 0.06))),
    slowResponseMs: number('SANDBOX_SLOW_RESPONSE_MS', 16_000),
  };
}
