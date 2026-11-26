// @vitest-environment node

/**
 * Gate table for `isMarketOpen()`: the cash session, 09:30 ET through the
 * close minute, on a trading day. /api/quotes, /api/intraday and
 * /api/yesterday read it to pick their cache lifetime.
 *
 * Like cron-helpers-gexbot-live.test.ts, it runs the REAL ET conversion and
 * market calendar against fixed UTC instants, so both DST regimes and the
 * holiday and half-day lookups are exercised end to end. The cases in
 * api-helpers.test.ts mock both modules, so they reach only the weekend and
 * holiday branches, not the open and close minutes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isMarketOpen } from '../_lib/cron-helpers.js';

describe('isMarketOpen', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    // ── EDT (UTC-4): Tue 2026-09-29 ──
    ['2026-09-29T04:00:00Z', false, 'EDT 00:00 ET, midnight'],
    ['2026-09-29T13:29:00Z', false, 'EDT 09:29 ET, a minute before the open'],
    ['2026-09-29T13:30:00Z', true, 'EDT 09:30 ET, the open'],
    ['2026-09-29T15:59:00Z', true, 'EDT 11:59 ET, midday'],
    ['2026-09-29T19:59:00Z', true, 'EDT 15:59 ET, the last full minute'],
    ['2026-09-29T20:00:00Z', true, 'EDT 16:00 ET, the close minute starts'],
    ['2026-09-29T20:00:59Z', true, 'EDT 16:00 ET, the close minute ends'],
    ['2026-09-29T20:01:00Z', false, 'EDT 16:01 ET, a minute after the close'],
    [
      '2026-09-29T20:30:00Z',
      false,
      'EDT 16:30 ET: the UTC instant that is open under EST',
    ],
    // ── EST (UTC-5): Tue 2026-12-01 ──
    ['2026-12-01T14:29:00Z', false, 'EST 09:29 ET, a minute before the open'],
    ['2026-12-01T14:30:00Z', true, 'EST 09:30 ET, the open'],
    [
      '2026-12-01T20:30:00Z',
      true,
      'EST 15:30 ET: the UTC instant that is closed under EDT',
    ],
    ['2026-12-01T21:00:59Z', true, 'EST 16:00 ET, the close minute ends'],
    ['2026-12-01T21:01:00Z', false, 'EST 16:01 ET, a minute after the close'],
    // ── Half-day: Fri 2026-11-27, Black Friday, 13:00 ET close ──
    ['2026-11-27T14:29:00Z', false, 'half-day 09:29 ET, before the open'],
    ['2026-11-27T14:30:00Z', true, 'half-day 09:30 ET, the open'],
    ['2026-11-27T17:59:00Z', true, 'half-day 12:59 ET'],
    ['2026-11-27T18:00:00Z', true, 'half-day 13:00 ET, the close minute'],
    ['2026-11-27T18:01:00Z', false, 'half-day 13:01 ET, after the early close'],
    ['2026-11-27T20:00:00Z', false, 'half-day 15:00 ET, normal-day hours'],
    // ── Closed days, at an hour that is open on a trading day ──
    ['2026-11-26T15:00:00Z', false, 'Thanksgiving holiday 10:00 ET'],
    ['2026-12-25T15:00:00Z', false, 'Christmas holiday 10:00 ET'],
    ['2026-10-03T15:00:00Z', false, 'Saturday 11:00 ET'],
    ['2026-10-04T15:00:00Z', false, 'Sunday 11:00 ET'],
  ])('%s → %s (%s)', (iso, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(iso));
    expect(isMarketOpen()).toBe(expected);
  });
});
