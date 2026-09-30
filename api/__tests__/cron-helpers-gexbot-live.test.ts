// @vitest-environment node

/**
 * Gate table for `isGexbotLiveCt()` — the GexBot capture window.
 *
 * Unlike the `isFuturesRthCt` cases in api-helpers.test.ts (which mock
 * the timezone + calendar modules), these run the REAL ET conversion and
 * market calendar against fixed UTC instants, so the DST regime and the
 * half-day / holiday lookups are exercised end to end.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isGexbotLiveCt } from '../_lib/cron-helpers.js';

describe('isGexbotLiveCt', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    // ── CDT / EDT regime (UTC-4 ET): 2026-09-29, a Tuesday ──
    ['2026-09-29T13:29:00Z', false, 'EDT 09:29 ET — one minute before open'],
    ['2026-09-29T13:30:00Z', true, 'EDT 09:30 ET — exact open'],
    ['2026-09-29T20:00:00Z', true, 'EDT 16:00 ET — close minute'],
    ['2026-09-29T20:01:00Z', true, 'EDT 16:01 ET — close + 1 (inclusive)'],
    ['2026-09-29T20:02:00Z', false, 'EDT 16:02 ET — close + 2'],
    [
      '2026-09-29T20:30:00Z',
      false,
      'EDT 16:30 ET (15:30 CDT) — the post-close hour the old gate allowed',
    ],
    // ── CST / EST regime (UTC-5 ET): 2026-12-01, a Tuesday ──
    ['2026-12-01T14:29:00Z', false, 'EST 09:29 ET — one minute before open'],
    ['2026-12-01T14:30:00Z', true, 'EST 09:30 ET — exact open'],
    [
      '2026-12-01T20:30:00Z',
      true,
      'EST 15:30 ET — same UTC instant that is post-close under EDT',
    ],
    ['2026-12-01T21:01:00Z', true, 'EST 16:01 ET — close + 1 (inclusive)'],
    ['2026-12-01T21:02:00Z', false, 'EST 16:02 ET — close + 2'],
    // ── Half-day: 2026-11-27 Black Friday, 13:00 ET close (EST) ──
    ['2026-11-27T18:01:00Z', true, 'half-day 13:01 ET — close + 1'],
    ['2026-11-27T18:02:00Z', false, 'half-day 13:02 ET — close + 2'],
    ['2026-11-27T20:00:00Z', false, 'half-day 15:00 ET — normal-day hours'],
    // ── Closed sessions ──
    ['2026-10-03T15:00:00Z', false, 'Saturday 11:00 ET'],
    ['2026-11-26T15:00:00Z', false, 'Thanksgiving holiday 10:00 ET'],
  ])('%s → %s (%s)', (iso, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(iso));
    expect(isGexbotLiveCt()).toBe(expected);
  });
});
