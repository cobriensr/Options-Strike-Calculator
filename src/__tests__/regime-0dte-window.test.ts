import { describe, it, expect } from 'vitest';

import {
  regime0dteSessionPhase,
  type Regime0dteSessionPhase,
} from '../utils/regime-0dte-window';
import { ctWallClockToUtcIso } from '../utils/timezone';

/** The instant a CT wall clock reads `hh:mm` on the CT calendar `date`. */
function ct(date: string, hh: number, mm: number): Date {
  return new Date(ctWallClockToUtcIso(date, hh * 60 + mm) as string);
}

const FRI = '2026-06-05';
const SAT = '2026-06-06';
const SUN = '2026-06-07';
const THANKSGIVING = '2026-11-26';
const BLACK_FRIDAY = '2026-11-27'; // early close: 12:00 CT

describe('regime0dteSessionPhase', () => {
  const cases: [string, Date, Regime0dteSessionPhase][] = [
    // A normal day: 08:30 CT up to, not including, 15:00 CT.
    ['a trading day at midnight', ct(FRI, 0, 0), 'before-open'],
    ['a trading day, a minute before the open', ct(FRI, 8, 29), 'before-open'],
    ['a trading day, at the open', ct(FRI, 8, 30), 'open'],
    ['a trading day, mid-session', ct(FRI, 11, 0), 'open'],
    ['a trading day, the last minute', ct(FRI, 14, 59), 'open'],
    ['a trading day, at the close', ct(FRI, 15, 0), 'after-close'],
    ['a trading day, late evening', ct(FRI, 23, 59), 'after-close'],
    // A half-day closes at 12:00 CT (13:00 ET).
    ['a half-day, before the open', ct(BLACK_FRIDAY, 8, 29), 'before-open'],
    ['a half-day, the last minute', ct(BLACK_FRIDAY, 11, 59), 'open'],
    ['a half-day, at the early close', ct(BLACK_FRIDAY, 12, 0), 'after-close'],
    [
      'a half-day, where a normal close would be',
      ct(BLACK_FRIDAY, 15, 0),
      'after-close',
    ],
    // No session at all: the clock position does not matter.
    ['a Saturday, mid-session hours', ct(SAT, 10, 0), 'no-session'],
    ['a Saturday, evening', ct(SAT, 20, 0), 'no-session'],
    ['a Sunday, morning', ct(SUN, 7, 0), 'no-session'],
    [
      'an NYSE holiday, mid-session hours',
      ct(THANKSGIVING, 10, 0),
      'no-session',
    ],
    ['an NYSE holiday, evening', ct(THANKSGIVING, 20, 0), 'no-session'],
  ];

  it.each(cases.map(([name, now, phase]) => ({ name, now, phase })))(
    '$name is $phase',
    ({ now, phase }) => {
      expect(regime0dteSessionPhase(now)).toBe(phase);
    },
  );

  // The day is the CT calendar date. 22:30 CT on Friday is already Saturday in
  // UTC (03:30), and 20:00 CT on Sunday is already Monday there (01:00).
  it('reads the CT calendar date, not the UTC one', () => {
    expect(regime0dteSessionPhase(ct(FRI, 22, 30))).toBe('after-close');
    expect(regime0dteSessionPhase(ct(SUN, 20, 0))).toBe('no-session');
  });
});
