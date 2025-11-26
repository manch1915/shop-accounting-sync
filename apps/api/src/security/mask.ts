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

// Fallback for bodies that are not JSON (form posts, HTML error pages, plain text).
// Rule: once a secret-looking key is followed by "=" or ":", everything up to the end of the
// line or the next "&" is hidden, unless the value is quoted. Over-masking a log line is fine,
// leaking a token is not, so this does not try to guess where a bare value ends.
// Keys: "double" or 'single' quoted with escapes, or bare with dots, brackets and %-escapes.
const KEY =
  /("((?:[^"\\]|\\.){1,256})"|'((?:[^'\\]|\\.){1,256})'|(?<![\w.%[\]-])([\w.%[\]-]{1,128}))(\s*[=:]\s*)/g;

function decodeKey(key: string): string {
  try {
    return decodeURIComponent(key.replace(/\+/g, ' '));
  } catch {
    return key;
  }
}

function quotedEnd(text: string, start: number, quote: string): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === quote) return i + 1;
  }
  return text.length;
}

function bareEnd(text: string, start: number): number {
  let i = start;
  while (i < text.length && text[i] !== '\n' && text[i] !== '\r' && text[i] !== '&') i++;
  return i;
}

function maskPairs(text: string): string {
  let out = '';
  let last = 0;
  KEY.lastIndex = 0;
  for (let m = KEY.exec(text); m; m = KEY.exec(text)) {
    const key = decodeKey(m[2] ?? m[3] ?? m[4] ?? '');
    if (!SECRET_KEY.test(key)) continue;
    const start = m.index + m[0].length;
    const quote = text[start] === '"' || text[start] === "'" ? text[start] : null;
    const end = quote ? quotedEnd(text, start, quote) : bareEnd(text, start);
    out += text.slice(last, start) + (quote ? `${quote}${MASK}${quote}` : MASK);
    last = end;
    KEY.lastIndex = Math.max(end, KEY.lastIndex);
  }
  return out + text.slice(last);
}

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
    // not JSON; the text scan below runs on a slice capped at MAX_BODY, so it stays linear
  }
  return truncate(maskPairs(body.slice(0, MAX_BODY).trim()), body.length);
}
