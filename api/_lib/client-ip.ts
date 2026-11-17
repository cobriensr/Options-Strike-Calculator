/**
 * Turn a raw client-IP header value into the string a rate limiter keys its
 * counter on.
 *
 * - IPv4: returned as written.
 * - IPv4-mapped IPv6 (`::ffff:203.0.113.7`): its IPv4 form, so a client counts
 *   once however the platform spells its address.
 * - Any other IPv6 address: its /64 network, `<h0>:<h1>:<h2>:<h3>::/64`, with
 *   lowercase hex and no zero padding. One subscriber normally holds a whole
 *   /64, so keying on the full address would give that subscriber billions of
 *   separate counters.
 * - Empty, missing, or not an address: `'unknown'`.
 *
 * Imports only `node:net` and no project module, so the cron path can use it
 * without pulling in the request helpers' Redis and botid imports.
 */

import { isIP } from 'node:net';

const UNKNOWN = 'unknown';

/** The eight 16-bit groups of a valid IPv6 literal that has no zone suffix. */
function ipv6Hextets(address: string): number[] {
  let text = address;
  // Fold an IPv4 tail ("::ffff:1.2.3.4") into the two hextets it stands for.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const [a = 0, b = 0, c = 0, d = 0] = tail.split('.').map(Number);
    const high = ((a << 8) | b).toString(16);
    const low = ((c << 8) | d).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const [head = '', rest] = text.split('::');
  const front = head === '' ? [] : head.split(':');
  const back = rest === undefined || rest === '' ? [] : rest.split(':');
  const zeros =
    rest === undefined
      ? []
      : Array.from({ length: 8 - front.length - back.length }, () => '0');
  return [...front, ...zeros, ...back].map((group) =>
    Number.parseInt(group, 16),
  );
}

function ipv6Key(address: string): string {
  const [h0 = 0, h1 = 0, h2 = 0, h3 = 0, h4 = 0, h5 = 0, h6 = 0, h7 = 0] =
    ipv6Hextets(address);
  const mapped = h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0;
  if (mapped && h5 === 0xffff) {
    return `${h6 >> 8}.${h6 & 0xff}.${h7 >> 8}.${h7 & 0xff}`;
  }
  return `${[h0, h1, h2, h3].map((group) => group.toString(16)).join(':')}::/64`;
}

export function rateLimitIp(raw: string | undefined): string {
  let address = raw?.trim() ?? '';
  // A zone ("fe80::1%eth0") names an interface, not part of the address.
  const zoneAt = address.indexOf('%');
  if (zoneAt > 0 && address.includes(':')) address = address.slice(0, zoneAt);

  const family = isIP(address);
  if (family === 4) return address;
  if (family === 6) return ipv6Key(address);
  return UNKNOWN;
}
