// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatMicrosIso, parseUwTimeMicros } from '../_lib/uw-time.js';

const NOW = '2026-10-29T12:00:00.000Z';

describe('parseUwTimeMicros', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each<[string, unknown, bigint]>([
    [
      'ISO with microseconds (REST /trades)',
      '2026-10-28T14:00:00.015573Z',
      1_793_196_000_015_573n,
    ],
    [
      'ISO at second precision (REST blocks)',
      '2026-10-29T03:27:26Z',
      1_793_244_446_000_000n,
    ],
    [
      'ISO with milliseconds',
      '2026-10-29T03:27:54.060Z',
      1_793_244_474_060_000n,
    ],
    [
      'nanoseconds are truncated to microseconds',
      '2026-10-28T14:00:00.015573999Z',
      1_793_196_000_015_573n,
    ],
    [
      'a +hh:mm offset is honored',
      '2026-10-28T09:00:00.5-05:00',
      1_793_196_000_500_000n,
    ],
    [
      'a +hhmm offset is honored',
      '2026-10-28T09:00:00-0500',
      1_793_196_000_000_000n,
    ],
    [
      'epoch ms number (websocket frames)',
      1_793_196_000_015,
      1_793_196_000_015_000n,
    ],
    ['epoch ms digit string', '1793196000015', 1_793_196_000_015_000n],
  ])('%s', (_label, input, expected) => {
    expect(parseUwTimeMicros(input)).toBe(expected);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['a boolean', true],
    ['an object', { t: 1 }],
    ['a naive ISO time (no zone)', '2026-10-28T14:00:00'],
    ['a date only', '2026-10-28'],
    ['garbage', 'not-a-time'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['epoch SECONDS (lands in 1970 as ms)', 1_793_196_000],
    ['before 2000-01-01', '1999-12-31T23:59:59Z'],
    ['more than 5 minutes in the future', '2026-10-29T12:05:01Z'],
    ['an impossible calendar date', '2026-02-30T00:00:00Z'],
  ])('rejects %s', (_label, input) => {
    expect(parseUwTimeMicros(input)).toBeNull();
  });

  it('accepts a time up to 5 minutes ahead of the clock (skew)', () => {
    expect(parseUwTimeMicros('2026-10-29T12:05:00Z')).toBe(
      1_793_275_500_000_000n,
    );
  });
});

describe('formatMicrosIso', () => {
  it.each<[bigint, string]>([
    [1_793_196_000_015_573n, '2026-10-28T14:00:00.015573Z'],
    [1_793_196_000_000_000n, '2026-10-28T14:00:00.000000Z'],
    [1_793_196_000_999_999n, '2026-10-28T14:00:00.999999Z'],
  ])('%s → %s', (us, iso) => {
    expect(formatMicrosIso(us)).toBe(iso);
  });

  it('round-trips through parseUwTimeMicros, so +1 µs is a valid cursor', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    try {
      const us = 1_793_196_000_015_573n;
      expect(parseUwTimeMicros(formatMicrosIso(us + 1n))).toBe(us + 1n);
    } finally {
      vi.useRealTimers();
    }
  });
});
