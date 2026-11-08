// @vitest-environment node

/**
 * Pure-function tests for api/_lib/strike-ladder.ts, the snapshot checks
 * shared by fetch-strike-exposure and fetch-strike-all.
 */

import { describe, it, expect } from 'vitest';
import {
  hasGammaSignal,
  isBeforeEtDay,
  judgeLadder,
  keepWithinRange,
  newestRowTime,
  strikeWindow,
} from '../_lib/strike-ladder.js';

function row(overrides: Record<string, string> = {}) {
  return {
    strike: '5800',
    time: '2026-11-09T15:00:00Z',
    call_gamma_oi: '500000',
    put_gamma_oi: '-300000',
    ...overrides,
  };
}

describe('strikeWindow', () => {
  it.each([
    [5800.5, 200, 5600, 6001],
    [5800, 200, 5600, 6000],
    [5799.9, 200, 5599, 6000],
    [612.34, 20, 592, 633],
  ])('spot %s ± %s -> [%s, %s]', (spot, range, min, max) => {
    // Floor / ceil so the request window always contains the exact window,
    // the same rounding fetch-gex-0dte uses for its min/max_strike.
    expect(strikeWindow(spot, range)).toEqual({
      minStrike: min,
      maxStrike: max,
    });
  });
});

describe('keepWithinRange', () => {
  it('keeps strikes inside spot ± range, both ends inclusive', () => {
    const rows = [
      row({ strike: '5599' }),
      row({ strike: '5600' }),
      row({ strike: '5800' }),
      row({ strike: '6000' }),
      row({ strike: '6001' }),
    ];
    expect(keepWithinRange(rows, 5800, 200).map((r) => r.strike)).toEqual([
      '5600',
      '5800',
      '6000',
    ]);
  });

  it('drops a row whose strike is not a number', () => {
    const rows = [row({ strike: 'abc' }), row({ strike: '5800' })];
    expect(keepWithinRange(rows, 5800, 200).map((r) => r.strike)).toEqual([
      '5800',
    ]);
  });
});

describe('newestRowTime', () => {
  it('returns the latest time as an ISO string, whatever the row order', () => {
    const rows = [
      row({ time: '2026-11-09T15:00:00Z' }),
      row({ time: '2026-11-09T15:07:30Z' }),
      row({ time: '2026-11-09T14:55:00Z' }),
    ];
    expect(newestRowTime(rows)).toBe('2026-11-09T15:07:30.000Z');
  });

  it('ignores unparseable times', () => {
    const rows = [
      row({ time: 'nonsense' }),
      row({ time: '2026-11-09T15:00:00Z' }),
    ];
    expect(newestRowTime(rows)).toBe('2026-11-09T15:00:00.000Z');
  });

  it('returns null for no rows or no parseable time', () => {
    expect(newestRowTime([])).toBeNull();
    expect(newestRowTime([row({ time: 'nonsense' })])).toBeNull();
  });
});

describe('isBeforeEtDay', () => {
  it('is true for a time on an earlier ET day (yesterday close at the 09:28 poll)', () => {
    // 2026-11-06 (Fri) 15:55 ET = 20:55Z; the poll runs Mon 11-09.
    expect(isBeforeEtDay('2026-11-06T20:55:00Z', '2026-11-09')).toBe(true);
  });

  it('is false for a time on the same ET day, pre-open included', () => {
    expect(isBeforeEtDay('2026-11-09T14:30:00Z', '2026-11-09')).toBe(false);
    expect(isBeforeEtDay('2026-11-09T09:00:00Z', '2026-11-09')).toBe(false);
  });

  it('judges the ET calendar day, not the UTC one', () => {
    // 2026-11-09 02:00Z is still 2026-11-08 21:00 ET (EST), the prior day.
    expect(isBeforeEtDay('2026-11-09T02:00:00Z', '2026-11-09')).toBe(true);
    // 2026-07-10 03:30Z is 2026-07-09 23:30 EDT, still the 9th.
    expect(isBeforeEtDay('2026-07-10T03:30:00Z', '2026-07-09')).toBe(false);
  });
});

describe('hasGammaSignal', () => {
  it('is true when at least one strike carries call or put gamma OI', () => {
    const rows = [
      row({ call_gamma_oi: '0', put_gamma_oi: '0' }),
      row({ call_gamma_oi: '0', put_gamma_oi: '-12' }),
    ];
    expect(hasGammaSignal(rows)).toBe(true);
  });

  it('is false when every strike is zero', () => {
    const rows = [
      row({ call_gamma_oi: '0', put_gamma_oi: '0' }),
      row({ call_gamma_oi: '0.00', put_gamma_oi: '-0' }),
    ];
    expect(hasGammaSignal(rows)).toBe(false);
  });

  it('treats blank and unparseable gamma as zero', () => {
    const rows = [
      row({ call_gamma_oi: '', put_gamma_oi: 'n/a' }),
      row({ call_gamma_oi: 'null', put_gamma_oi: '' }),
    ];
    expect(hasGammaSignal(rows)).toBe(false);
  });

  it('is false for an empty ladder', () => {
    expect(hasGammaSignal([])).toBe(false);
  });
});

describe('judgeLadder', () => {
  // Day 2026-11-09, spot 7385, range 200: stored strikes are 7185..7585.
  const opts = { spot: 7385, range: 200, day: '2026-11-09' };
  const live = (strike: string) =>
    row({ strike, time: '2026-11-09T15:00:00Z' });

  it('stores the in-range rows with the newest row time', () => {
    const rows = [
      live('7100'),
      row({ strike: '7385', time: '2026-11-09T15:07:00Z' }),
      live('7590'),
    ];
    const verdict = judgeLadder(rows, opts);
    expect(verdict).toEqual({
      kind: 'store',
      rows: [rows[1]],
      snapshotTime: '2026-11-09T15:07:00.000Z',
    });
  });

  it('is empty for no rows', () => {
    expect(judgeLadder([], opts)).toEqual({ kind: 'empty' });
  });

  it('is malformed when no row has a parseable time', () => {
    expect(judgeLadder([row({ time: 'garbage' })], opts)).toEqual({
      kind: 'malformed',
    });
  });

  it('is stale when the newest row is from an earlier ET day, naming that day', () => {
    // Friday 11-06 close, the 09:28 ET poll on Monday 11-09.
    const rows = [row({ time: '2026-11-06T21:00:00Z', strike: '7385' })];
    expect(judgeLadder(rows, opts)).toEqual({
      kind: 'stale',
      dataEtDate: '2026-11-06',
      snapshotTime: '2026-11-06T21:00:00.000Z',
    });
  });

  it('judges staleness on the newest row, so one lagging strike is not stale', () => {
    // UW lets a rarely traded strike keep a time from hours ago.
    const rows = [
      row({ strike: '7385', time: '2026-11-09T15:00:00Z' }),
      row({ strike: '7390', time: '2026-11-06T21:00:00Z' }),
    ];
    expect(judgeLadder(rows, opts).kind).toBe('store');
  });

  it('is outside_window when rows came back but none is inside spot ± range', () => {
    const rows = [live('6000'), live('8000')];
    expect(judgeLadder(rows, opts)).toEqual({
      kind: 'outside_window',
      total: 2,
    });
  });

  it('is all_zero when the in-range strikes carry no gamma', () => {
    const rows = [
      row({
        strike: '7385',
        call_gamma_oi: '0',
        put_gamma_oi: '0',
        time: '2026-11-09T15:00:00Z',
      }),
      live('8000'),
    ];
    expect(judgeLadder(rows, opts)).toEqual({ kind: 'all_zero', total: 1 });
  });

  it('checks in order: stale before outside_window before all_zero', () => {
    const zero = { call_gamma_oi: '0', put_gamma_oi: '0' };
    const stale = row({
      strike: '9000',
      time: '2026-11-06T21:00:00Z',
      ...zero,
    });
    expect(judgeLadder([stale], opts).kind).toBe('stale');
    const outside = row({
      strike: '9000',
      time: '2026-11-09T15:00:00Z',
      ...zero,
    });
    expect(judgeLadder([outside], opts).kind).toBe('outside_window');
  });
});
