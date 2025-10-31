import { createHmac, timingSafeEqual } from 'node:crypto';

export function hmacSha256(
  secret: string,
  payload: Buffer | string,
  encoding: 'base64' | 'hex' = 'base64',
): string {
  return createHmac('sha256', secret).update(payload).digest(encoding);
}

export function safeEqual(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
