import { isIPv4, isIPv6 } from 'node:net';

/** Eight 16-bit groups of an IPv6 address, or null when it is not one. */
function expandIPv6(raw: string): number[] | null {
  const ip = raw.split('%')[0]?.toLowerCase() ?? '';
  if (!isIPv6(ip)) return null;
  let text = ip;
  // an embedded IPv4 tail (::ffff:1.2.3.4) becomes two groups
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  if (v4) {
    const [a = 0, b = 0, c = 0, d = 0] = v4.split('.').map(Number);
    text = `${text.slice(0, -v4.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const zeros = tail === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array<string>(zeros).fill('0'), ...right].map((g) => Number.parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * Key for per-client limits. IPv4 (and IPv4-mapped IPv6) is used as is; native IPv6 is reduced to
 * its /64, since one subscriber usually owns the whole prefix and can rotate addresses inside it.
 */
export function clientKey(ip: string | undefined): string {
  if (!ip) return 'unknown';
  if (isIPv4(ip)) return ip;
  const groups = expandIPv6(ip);
  if (!groups) return `raw:${ip}`;
  const isMapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (isMapped) {
    const [hi = 0, lo = 0] = groups.slice(6);
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`;
}
