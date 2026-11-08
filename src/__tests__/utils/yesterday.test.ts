import { describe, it, expect } from 'vitest';
import { resolveYesterday } from '../../utils/yesterday';
import type { DaySummary } from '../../types/api';

const day = (date: string, open: number): DaySummary => ({
  date,
  open,
  high: open + 40,
  low: open - 40,
  close: open + 10,
  rangePct: 1,
  rangePts: 80,
});

const FROM_HISTORY = day('2026-11-02', 7500);
const FROM_LIVE = day('2026-11-03', 7650);

/**
 * Yesterday for the cluster multiplier, the put/call tilt and the range
 * analysis, resolved once. The live feed's yesterday is the day before TODAY,
 * so a past date must never take it as its own.
 */
describe('resolveYesterday', () => {
  it.each([
    ['a past date', true],
    ['today', false],
  ])(
    "%s: the history snapshot's yesterday wins over the live feed",
    (_n, past) => {
      expect(resolveYesterday(FROM_HISTORY, FROM_LIVE, past)).toBe(
        FROM_HISTORY,
      );
    },
  );

  // Null is a snapshot with no previous day; undefined is no snapshot.
  it.each([null, undefined])(
    "today with snapshot yesterday %s: the live feed's, which is the right day",
    (snapshot) => {
      expect(resolveYesterday(snapshot, FROM_LIVE, false)).toBe(FROM_LIVE);
    },
  );

  it.each([
    ['a snapshot with no previous day (previousDay null)', null],
    ['no snapshot (history loading, or no candle for the slot)', undefined],
  ])('a past date with %s: null, never the live feed', (_n, snapshot) => {
    expect(resolveYesterday(snapshot, FROM_LIVE, true)).toBeNull();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('no data anywhere (live %s): null', (_n, live) => {
    expect(resolveYesterday(null, live, false)).toBeNull();
    expect(resolveYesterday(null, live, true)).toBeNull();
  });
});
