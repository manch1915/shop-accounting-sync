const SECRET_KEY =
  /(authorization|token|secret|password|passwd|api[-_ ]?key|consumer[-_ ]?key|cookie|signature|hmac|code_verifier|^code$)/i;
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
// The text is capped at MAX_BODY before these run, and every alternation below is disjoint,
// so the scans stay linear.
// "any key": <string with escapes | bare value>
const JSON_PAIR = /("((?:[^"\\]|\\.){1,256})"\s*:\s*)("(?:[^"\\]|\\.)*"|[^\s,}\]]+)/g;
// Header-style line: the whole rest of the line is the value ("Bearer abc", "Basic xyz")
const HEADER_LINE = /^([ \t]*)([^\s:=]{1,128})([ \t]*:[ \t]*)([^\r\n]+)$/gm;
// key=value anywhere, keys may contain dots and brackets (client.secret, auth[token])
const KV_PAIR = /(^|[^\w.[\]-])([\w.[\]-]{1,128})(\s*=\s*)([^\s&"',;<>]+)/g;

function truncate(text: string, originalLength = text.length): string {
  const cut = text.length > MAX_BODY ? text.slice(0, MAX_BODY) : text;
  return originalLength > MAX_BODY ? `${cut}\n… truncated ${originalLength - MAX_BODY} chars` : cut;
}

// Content-Type is not trusted: providers send JSON as text/plain and errors as HTML.
export function maskBody(body: string | null, _contentType: string | null): string | null {
  if (body === null || body.trim() === '') return null;
  try {
    return truncate(JSON.stringify(maskJson(JSON.parse(body)), null, 2));
  } catch {
    // not JSON, handled below on a bounded slice
  }
  const text = body.slice(0, MAX_BODY).trim();
  if (FORM_BODY.test(text)) {
    const params = new URLSearchParams(text);
    for (const key of [...params.keys()]) {
      if (SECRET_KEY.test(key)) params.set(key, MASK);
    }
    return truncate(params.toString(), body.length);
  }
  const masked = text
    .replace(JSON_PAIR, (all, prefix: string, key: string) =>
      SECRET_KEY.test(key) ? `${prefix}"${MASK}"` : all,
    )
    .replace(HEADER_LINE, (all, lead: string, key: string, sep: string) =>
      SECRET_KEY.test(key) ? `${lead}${key}${sep}${MASK}` : all,
    )
    .replace(KV_PAIR, (all, lead: string, key: string, sep: string) =>
      SECRET_KEY.test(key) ? `${lead}${key}${sep}${MASK}` : all,
    );
  return truncate(masked, body.length);
}
