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

const FORM_BODY = /^[^\s=&]+=[^\s&]*(&[^\s=&]+=[^\s&]*)*$/;
const JSON_PAIR = /("([^"]+)"\s*:\s*)"[^"]*"/g;
const KV_PAIR = /\b([\w-]+)=([^\s&"',;]+)/g;

// Content-Type is not trusted: providers send JSON as text/plain and errors as HTML.
export function maskBody(body: string | null, _contentType: string | null): string | null {
  if (body === null || body === '') return null;
  let masked: string;
  try {
    masked = JSON.stringify(maskJson(JSON.parse(body)), null, 2);
  } catch {
    if (FORM_BODY.test(body)) {
      const params = new URLSearchParams(body);
      for (const key of [...params.keys()]) {
        if (SECRET_KEY.test(key)) params.set(key, MASK);
      }
      masked = params.toString();
    } else {
      masked = body
        .replace(JSON_PAIR, (all, prefix: string, key: string) =>
          SECRET_KEY.test(key) ? `${prefix}"${MASK}"` : all,
        )
        .replace(KV_PAIR, (all, key: string) => (SECRET_KEY.test(key) ? `${key}=${MASK}` : all));
    }
  }
  return masked.length > MAX_BODY
    ? `${masked.slice(0, MAX_BODY)}\n… truncated ${masked.length - MAX_BODY} chars`
    : masked;
}
