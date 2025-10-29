const SECRET_KEY =
  /(authorization|token|secret|password|passwd|api[-_]?key|consumer[-_]?key|cookie|signature|hmac|code_verifier|^code$)/i;
const MASK = '••••';
const MAX_BODY = 16_000;

export function maskValue(value: string): string {
  if (value.length <= 8) return MASK;
  // keep the scheme ("Bearer", "Basic") and the last 4 chars so people can tell keys apart
  const [scheme, rest] = value.includes(' ') ? value.split(/ (.+)/) : [null, value];
  const tail = (rest ?? value).slice(-4);
  return scheme ? `${scheme} ${MASK}${tail}` : `${MASK}${tail}`;
}

export function maskHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SECRET_KEY.test(key) ? maskValue(value) : value;
  }
  return out;
}

export function maskUrl(raw: string): string {
  const url = new URL(raw);
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_KEY.test(key)) url.searchParams.set(key, MASK);
  }
  if (url.password) url.password = MASK;
  return url.toString();
}

function maskJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskJson);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) && typeof inner === 'string' ? maskValue(inner) : maskJson(inner);
    }
    return out;
  }
  return value;
}

export function maskBody(body: string | null, contentType: string | null): string | null {
  if (body === null || body === '') return null;
  let masked = body;
  if (contentType?.includes('json')) {
    try {
      masked = JSON.stringify(maskJson(JSON.parse(body)), null, 2);
    } catch {
      // not valid JSON despite the header, store as is
    }
  } else if (contentType?.includes('x-www-form-urlencoded')) {
    const params = new URLSearchParams(body);
    for (const key of [...params.keys()]) {
      if (SECRET_KEY.test(key)) params.set(key, MASK);
    }
    masked = params.toString();
  }
  return masked.length > MAX_BODY
    ? `${masked.slice(0, MAX_BODY)}\n… truncated ${masked.length - MAX_BODY} chars`
    : masked;
}
