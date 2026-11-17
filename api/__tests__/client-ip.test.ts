// @vitest-environment node

/**
 * `rateLimitIp` turns the raw client-IP header value into the string a rate
 * limiter keys its counter on: IPv4 as is, an IPv4-mapped IPv6 address as its
 * IPv4 form, and any other IPv6 address as its /64 network, because one
 * subscriber normally holds a whole /64.
 */

import { describe, expect, it } from 'vitest';
import { rateLimitIp } from '../_lib/client-ip.js';

describe('rateLimitIp', () => {
  it.each<[string, string | undefined, string]>([
    ['an IPv4 address', '203.0.113.7', '203.0.113.7'],
    ['an IPv4-mapped IPv6 address', '::ffff:203.0.113.7', '203.0.113.7'],
    [
      'an IPv4-mapped address written in hex',
      '::ffff:cb00:7107',
      '203.0.113.7',
    ],
    ['an uppercase IPv4-mapped prefix', '::FFFF:203.0.113.7', '203.0.113.7'],
    [
      'a full IPv6 address, reduced to its /64',
      '2001:db8:1:2:3:4:5:6',
      '2001:db8:1:2::/64',
    ],
    [
      'a compressed IPv6 address, zero hextets spelled "0"',
      '2001:db8::1',
      '2001:db8:0:0::/64',
    ],
    ['an IPv6 address with a zone suffix', 'fe80::1%eth0', 'fe80:0:0:0::/64'],
    [
      'an IPv4-mapped address with a zone suffix',
      '::ffff:203.0.113.7%eth0',
      '203.0.113.7',
    ],
    ['the IPv6 loopback', '::1', '0:0:0:0::/64'],
    [
      'an IPv6 address written with uppercase hex',
      '2001:DB8:ABCD:12::1',
      '2001:db8:abcd:12::/64',
    ],
    [
      'an IPv6 address with leading zeros in a hextet',
      '2001:0db8:0001:0002::5',
      '2001:db8:1:2::/64',
    ],
    ['an IPv6 address compressed at the end', '1:2:3:4::', '1:2:3:4::/64'],
    ['surrounding whitespace', ' 203.0.113.7 ', '203.0.113.7'],
    ['an empty string', '', 'unknown'],
    ['a blank string', '   ', 'unknown'],
    ['an undefined value', undefined, 'unknown'],
    ['text that is not an address', 'not-an-ip', 'unknown'],
    ['an IPv4 address with a port', '203.0.113.7:443', 'unknown'],
    ['a bracketed IPv6 address', '[2001:db8::1]', 'unknown'],
    ['an IPv4 address with a zone suffix', '203.0.113.7%eth0', 'unknown'],
  ])('maps %s', (_label, raw, expected) => {
    expect(rateLimitIp(raw)).toBe(expected);
  });

  it('gives two addresses in one /64 the same value and another /64 a different one', () => {
    const a = rateLimitIp('2001:db8:aaaa:bbbb:1111:2222:3333:4444');
    const b = rateLimitIp('2001:db8:aaaa:bbbb:ffff:eeee:dddd:cccc');
    const c = rateLimitIp('2001:db8:aaaa:bbbc:1111:2222:3333:4444');

    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });
});
