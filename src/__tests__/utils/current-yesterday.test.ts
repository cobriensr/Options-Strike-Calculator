import { describe, it, expect } from 'vitest';
import { currentYesterday } from '../../utils/current-yesterday';
import type { DaySummary } from '../../types/api';

// /api/yesterday answers with the last completed session before today, and the
// page holds it across the day. Held across a night, or served from an edge
// cache a day old, it is a previous day's: yesterday is only the one whose
// date is the last trading day before today's ET date.
function day(date: string): DaySummary {
  return {
    date,
    open: 6781,
    high: 7198.67,
    low: 6882.66,
    close: 7100,
    rangePct: 4.66,
    rangePts: 316.01,
  };
}

describe('currentYesterday', () => {
  it.each([
    // [what the case is, the held day's date, etToday, current?]
    ['Monday gets Friday', '2026-11-20', '2026-11-23', true],
    ['Tuesday gets Monday', '2026-11-23', '2026-11-24', true],
    ['Saturday gets Friday', '2026-11-20', '2026-11-21', true],
    ['Sunday gets Friday', '2026-11-20', '2026-11-22', true],
    [
      'the Tuesday after a holiday Monday (Memorial Day 2026-05-25) gets Friday',
      '2026-05-22',
      '2026-05-26',
      true,
    ],
    ['the holiday Monday itself gets Friday', '2026-05-22', '2026-05-25', true],
    [
      'the day after Thanksgiving gets Wednesday, not the holiday',
      '2026-11-25',
      '2026-11-27',
      true,
    ],
    [
      'a holiday (Thanksgiving) is not a day that completed',
      '2026-11-26',
      '2026-11-27',
      false,
    ],
    [
      "a stale Thursday on Tuesday: Friday's morning body served a day late",
      '2026-11-19',
      '2026-11-24',
      false,
    ],
    [
      "Friday's value on Tuesday, a day too old",
      '2026-11-20',
      '2026-11-24',
      false,
    ],
    ['today itself is not yesterday', '2026-11-24', '2026-11-24', false],
    ['a future date', '2026-11-25', '2026-11-24', false],
  ])('%s', (_label, date, etToday, isCurrent) => {
    const held = day(date);

    expect(currentYesterday(held, etToday)).toBe(isCurrent ? held : null);
  });

  it('is null for a null or undefined value', () => {
    expect(currentYesterday(null, '2026-11-24')).toBeNull();
    expect(currentYesterday(undefined, '2026-11-24')).toBeNull();
  });

  it('returns the held object itself, whatever else it carries', () => {
    const held = { ...day('2026-11-23'), extra: 'kept' };

    expect(currentYesterday(held, '2026-11-24')).toBe(held);
  });

  it.each(['', 'not-a-date', '2026-13-45'])(
    'does not throw on a malformed etToday (%j)',
    (etToday) => {
      expect(currentYesterday(day('2026-11-23'), etToday)).toBeNull();
    },
  );
});
