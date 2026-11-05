// @vitest-environment node

/**
 * Gate table for `isConeCalcWindow()`: compute-cone's 09:30–09:45 ET window.
 * Like cron-helpers-gexbot-live.test.ts, it runs the REAL ET conversion and
 * market calendar against fixed UTC instants, so both DST regimes and the
 * holiday and half-day lookups are exercised end to end.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isConeCalcWindow } from '../_lib/cron-helpers.js';

describe('isConeCalcWindow', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    // ── EDT (UTC-4): Fri 2026-10-30 ──
    ['2026-10-30T13:29:00Z', false, 'EDT 09:29 ET, before the open'],
    ['2026-10-30T13:30:00Z', true, 'EDT 09:30 ET, the open'],
    ['2026-10-30T13:32:00Z', true, 'EDT 09:32 ET, the 13:32 UTC slot'],
    ['2026-10-30T13:45:59Z', true, 'EDT 09:45 ET, the last minute in'],
    ['2026-10-30T13:46:00Z', false, 'EDT 09:46 ET, past the window'],
    ['2026-10-30T14:32:00Z', false, 'EDT 10:32 ET, the 14:32 UTC slot'],
    // ── EST (UTC-5): Mon 2026-11-02 ──
    ['2026-11-02T13:32:00Z', false, 'EST 08:32 ET, the 13:32 UTC slot'],
    ['2026-11-02T14:29:00Z', false, 'EST 09:29 ET, before the open'],
    ['2026-11-02T14:32:00Z', true, 'EST 09:32 ET, the 14:32 UTC slot'],
    ['2026-11-02T14:46:00Z', false, 'EST 09:46 ET, past the window'],
    // ── Half-day and closed sessions ──
    ['2026-11-27T14:32:00Z', true, 'Black Friday (13:00 close) 09:32 ET'],
    ['2026-11-26T14:32:00Z', false, 'Thanksgiving 09:32 ET'],
    ['2026-10-31T13:32:00Z', false, 'Saturday 09:32 ET'],
  ])('%s → %s (%s)', (iso, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(iso));
    expect(isConeCalcWindow()).toBe(expected);
  });
});
