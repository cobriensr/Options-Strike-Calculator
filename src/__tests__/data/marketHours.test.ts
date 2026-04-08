import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  getMarketCloseHourET,
  getEarlyCloseHourET,
  isHoliday,
  isHalfDay,
  isTradingDay,
  currentSessionStage,
  ACTIVE_SESSION_STAGES,
  type SessionStage,
} from '../../data/marketHours';

describe('getMarketCloseHourET', () => {
  it('returns null for market-closed dates', () => {
    expect(getMarketCloseHourET('2025-12-25')).toBeNull(); // Christmas
    expect(getMarketCloseHourET('2025-11-27')).toBeNull(); // Thanksgiving
    expect(getMarketCloseHourET('2026-01-19')).toBeNull(); // MLK Day
  });

  it('returns 13 for early-close dates', () => {
    expect(getMarketCloseHourET('2025-11-28')).toBe(13); // Black Friday
    expect(getMarketCloseHourET('2025-12-24')).toBe(13); // Christmas Eve
    expect(getMarketCloseHourET('2026-12-24')).toBe(13); // Christmas Eve
  });

  it('returns 16 for normal trading days', () => {
    expect(getMarketCloseHourET('2025-06-02')).toBe(16);
    expect(getMarketCloseHourET('2025-10-15')).toBe(16);
  });
});

describe('getEarlyCloseHourET', () => {
  it('returns 13 for early-close dates', () => {
    expect(getEarlyCloseHourET('2025-07-03')).toBe(13);
    expect(getEarlyCloseHourET('2026-12-24')).toBe(13);
  });

  it('returns undefined for normal trading days', () => {
    expect(getEarlyCloseHourET('2025-06-02')).toBeUndefined();
  });

  it('returns undefined for market-closed dates', () => {
    expect(getEarlyCloseHourET('2025-12-25')).toBeUndefined();
  });
});

describe('isHoliday', () => {
  it('returns true for full-day market closures', () => {
    expect(isHoliday('2025-12-25')).toBe(true); // Christmas
    expect(isHoliday('2025-11-27')).toBe(true); // Thanksgiving
    expect(isHoliday('2026-01-19')).toBe(true); // MLK Day
    expect(isHoliday('2026-07-03')).toBe(true); // Independence Day observed
  });

  it('returns false for half-days (still trading days)', () => {
    expect(isHoliday('2025-11-28')).toBe(false); // Black Friday
    expect(isHoliday('2025-12-24')).toBe(false); // Christmas Eve
    expect(isHoliday('2026-12-24')).toBe(false);
  });

  it('returns false for normal trading days', () => {
    expect(isHoliday('2025-06-02')).toBe(false);
    expect(isHoliday('2026-04-08')).toBe(false);
  });

  it('returns false for weekends not in the closed-dates set', () => {
    // 2026-04-04 is a Saturday — not in the closed-dates set, so not a "holiday"
    // even though it's also not a trading day.
    expect(isHoliday('2026-04-04')).toBe(false);
  });
});

describe('isHalfDay', () => {
  it('returns true for early-close dates', () => {
    expect(isHalfDay('2025-07-03')).toBe(true); // Day before July 4th (Thu)
    expect(isHalfDay('2025-11-28')).toBe(true); // Black Friday
    expect(isHalfDay('2025-12-24')).toBe(true); // Christmas Eve
    expect(isHalfDay('2026-12-24')).toBe(true);
  });

  it('returns false for full-day market closures', () => {
    expect(isHalfDay('2025-12-25')).toBe(false);
    expect(isHalfDay('2025-11-27')).toBe(false);
  });

  it('returns false for normal trading days', () => {
    expect(isHalfDay('2025-06-02')).toBe(false);
    expect(isHalfDay('2026-04-08')).toBe(false);
  });

  it('returns false for 2026-07-03 (observed Independence Day, not a half-day)', () => {
    // July 4, 2026 is a Saturday → July 3 is the observed Independence Day
    // FULL closure, not an early close. Regression test for the data-entry
    // mistake where 2026-07-03 appeared in both EARLY_CLOSE_DATES and
    // MARKET_CLOSED_DATES. The defensive isHalfDay short-circuits on
    // holidays, and the bad EARLY_CLOSE_DATES entry has been removed.
    expect(isHalfDay('2026-07-03')).toBe(false);
    expect(isHoliday('2026-07-03')).toBe(true);
  });
});

describe('isTradingDay', () => {
  it('returns true for normal weekday trading days', () => {
    expect(isTradingDay('2026-04-08')).toBe(true); // Wed
    expect(isTradingDay('2025-06-02')).toBe(true); // Mon
    expect(isTradingDay('2025-10-15')).toBe(true); // Wed
  });

  it('returns true for half-days (still trading days)', () => {
    expect(isTradingDay('2025-11-28')).toBe(true); // Black Friday
    expect(isTradingDay('2025-12-24')).toBe(true); // Christmas Eve
  });

  it('returns false for full-day holidays', () => {
    expect(isTradingDay('2025-12-25')).toBe(false); // Christmas
    expect(isTradingDay('2025-11-27')).toBe(false); // Thanksgiving
    expect(isTradingDay('2026-01-19')).toBe(false); // MLK Day
    expect(isTradingDay('2026-07-03')).toBe(false); // Independence Day observed
  });

  it('returns false for weekends', () => {
    expect(isTradingDay('2026-04-04')).toBe(false); // Sat
    expect(isTradingDay('2026-04-05')).toBe(false); // Sun
    expect(isTradingDay('2025-06-07')).toBe(false); // Sat
    expect(isTradingDay('2025-06-08')).toBe(false); // Sun
  });

  it('returns false for malformed input rather than throwing', () => {
    expect(isTradingDay('')).toBe(false);
    expect(isTradingDay('not-a-date')).toBe(false);
    expect(isTradingDay('2026-13-01')).toBe(false); // invalid month
    expect(isTradingDay('2026-04')).toBe(false); // missing day
    expect(isTradingDay('2026/04/08')).toBe(false); // wrong separator
  });
});

describe('currentSessionStage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Set the system clock to a specific CT hour/minute on a given
   * weekday in March 2026. Mirrors the pattern in
   * TradingScheduleSection.test.tsx: March 2026 is CDT (UTC-5), and
   * 2026-03-31 is a Tuesday, so we build UTC = `hour + 5`.
   */
  function mockCT(hour: number, minute: number, weekdayOffsetFromTue = 0) {
    // 2026-03-31 is Tuesday; advance or retreat by weekdayOffsetFromTue.
    // Monday = -1, Tue = 0, Wed = 1, Thu = 2, Fri = 3.
    const utc = new Date(
      Date.UTC(2026, 2, 31 + weekdayOffsetFromTue, hour + 5, minute, 0),
    );
    vi.setSystemTime(utc);
  }

  it('returns "closed" on weekends', () => {
    // 2026-03-28 is a Saturday, 10:00 CT (= 15:00 UTC in CDT)
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 28, 15, 0, 0)));
    expect(currentSessionStage()).toBe('closed');
  });

  it('returns "closed" on Sunday', () => {
    // 2026-03-29 is a Sunday
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 29, 15, 0, 0)));
    expect(currentSessionStage()).toBe('closed');
  });

  it('returns "closed" on full-day holidays', () => {
    // 2026-01-19 is MLK Day (Monday). 10:00 CT = 16:00 UTC in CST.
    vi.setSystemTime(new Date(Date.UTC(2026, 0, 19, 16, 0, 0)));
    expect(currentSessionStage()).toBe('closed');
  });

  it('returns "half-day" on NYSE early-close days', () => {
    // 2026-11-27 is Black Friday. 10:00 CT = 16:00 UTC in CST.
    vi.setSystemTime(new Date(Date.UTC(2026, 10, 27, 16, 0, 0)));
    expect(currentSessionStage()).toBe('half-day');
  });

  it('returns "pre-market" before 8:30 CT on a trading day', () => {
    mockCT(7, 0);
    expect(currentSessionStage()).toBe('pre-market');
  });

  it('returns "pre-market" at exactly 8:29 CT', () => {
    mockCT(8, 29);
    expect(currentSessionStage()).toBe('pre-market');
  });

  it('returns "opening-range" at exactly 8:30 CT', () => {
    mockCT(8, 30);
    expect(currentSessionStage()).toBe('opening-range');
  });

  it('returns "opening-range" at 8:45 CT', () => {
    mockCT(8, 45);
    expect(currentSessionStage()).toBe('opening-range');
  });

  it('returns "credit-spreads" at exactly 9:00 CT', () => {
    mockCT(9, 0);
    expect(currentSessionStage()).toBe('credit-spreads');
  });

  it('returns "credit-spreads" at 10:00 CT', () => {
    mockCT(10, 0);
    expect(currentSessionStage()).toBe('credit-spreads');
  });

  it('returns "credit-spreads" at 11:29 CT (last minute)', () => {
    mockCT(11, 29);
    expect(currentSessionStage()).toBe('credit-spreads');
  });

  it('returns "directional" at exactly 11:30 CT', () => {
    mockCT(11, 30);
    expect(currentSessionStage()).toBe('directional');
  });

  it('returns "directional" at 12:00 CT', () => {
    mockCT(12, 0);
    expect(currentSessionStage()).toBe('directional');
  });

  it('returns "bwb" at exactly 1:00 PM CT', () => {
    mockCT(13, 0);
    expect(currentSessionStage()).toBe('bwb');
  });

  it('returns "bwb" at 2:00 PM CT', () => {
    mockCT(14, 0);
    expect(currentSessionStage()).toBe('bwb');
  });

  it('returns "late-bwb" at exactly 2:30 PM CT', () => {
    mockCT(14, 30);
    expect(currentSessionStage()).toBe('late-bwb');
  });

  it('returns "late-bwb" at 2:40 PM CT (middle of the gap)', () => {
    mockCT(14, 40);
    expect(currentSessionStage()).toBe('late-bwb');
  });

  it('returns "late-bwb" at 2:54 PM CT (last minute before flat)', () => {
    mockCT(14, 54);
    expect(currentSessionStage()).toBe('late-bwb');
  });

  it('returns "flat" at exactly 2:55 PM CT', () => {
    mockCT(14, 55);
    expect(currentSessionStage()).toBe('flat');
  });

  it('returns "flat" at 2:59 PM CT', () => {
    mockCT(14, 59);
    expect(currentSessionStage()).toBe('flat');
  });

  it('returns "post-close" at exactly 3:00 PM CT', () => {
    mockCT(15, 0);
    expect(currentSessionStage()).toBe('post-close');
  });

  it('returns "post-close" at 4:00 PM CT', () => {
    mockCT(16, 0);
    expect(currentSessionStage()).toBe('post-close');
  });

  it('accepts an explicit Date argument instead of reading the system clock', () => {
    // Sunday April 5, 2026 at any time → closed
    const sundayInstant = new Date(Date.UTC(2026, 3, 5, 15, 0, 0));
    expect(currentSessionStage(sundayInstant)).toBe('closed');

    // Monday April 6, 2026 at 10:00 CT = 15:00 UTC in CDT → credit-spreads
    const mondayInstant = new Date(Date.UTC(2026, 3, 6, 15, 0, 0));
    expect(currentSessionStage(mondayInstant)).toBe('credit-spreads');
  });
});

describe('ACTIVE_SESSION_STAGES', () => {
  it('contains exactly the five actionable user-schedule phases', () => {
    const actionable: SessionStage[] = [
      'opening-range',
      'credit-spreads',
      'directional',
      'bwb',
      'flat',
    ];
    expect(ACTIVE_SESSION_STAGES.size).toBe(actionable.length);
    for (const stage of actionable) {
      expect(ACTIVE_SESSION_STAGES.has(stage)).toBe(true);
    }
  });

  it('does not include non-actionable stages', () => {
    const nonActionable: SessionStage[] = [
      'pre-market',
      'late-bwb',
      'post-close',
      'half-day',
      'closed',
    ];
    for (const stage of nonActionable) {
      expect(ACTIVE_SESSION_STAGES.has(stage)).toBe(false);
    }
  });
});
