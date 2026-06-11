import { describe, it, expect } from 'vitest';
import {
  getTradingDays,
  getTradingDaysForward,
  ctDateStr,
} from './trading-days.mjs';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function weekday(dateStr) {
  // Same midday-CT anchor the helper uses.
  return new Date(`${dateStr}T18:00:00Z`).getUTCDay();
}

describe('getTradingDays', () => {
  it('returns `count` ascending ISO dates, all weekdays, distinct', () => {
    const out = getTradingDays(10);
    expect(out).toHaveLength(10);
    expect(new Set(out).size).toBe(10);
    expect([...out].sort((a, b) => a.localeCompare(b))).toEqual(out);
    for (const d of out) {
      expect(d).toMatch(ISO_DATE);
      expect(weekday(d)).toBeGreaterThanOrEqual(1);
      expect(weekday(d)).toBeLessThanOrEqual(5);
    }
  });

  it('never returns a date after today in CT', () => {
    const today = ctDateStr();
    for (const d of getTradingDays(20)) expect(d <= today).toBe(true);
  });
});

describe('getTradingDaysForward', () => {
  it('walks forward from a weekday start, inclusive', () => {
    // 2026-06-01 is a Monday.
    expect(getTradingDaysForward('2026-06-01', 5)).toEqual([
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
      '2026-06-04',
      '2026-06-05',
    ]);
  });

  it('skips weekends', () => {
    // Fri 2026-06-05 -> skip Sat/Sun -> Mon 06-08, Tue 06-09.
    expect(getTradingDaysForward('2026-06-05', 3)).toEqual([
      '2026-06-05',
      '2026-06-08',
      '2026-06-09',
    ]);
  });

  it('skips a weekend start date', () => {
    // Sat 2026-06-06 -> first trading day is Mon 06-08.
    expect(getTradingDaysForward('2026-06-06', 2)).toEqual([
      '2026-06-08',
      '2026-06-09',
    ]);
  });

  it('does not return dates past today in CT', () => {
    // A far-future start yields nothing (capped at today).
    expect(getTradingDaysForward('2999-01-01', 5)).toEqual([]);
  });
});
