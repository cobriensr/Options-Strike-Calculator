import { describe, it, expect } from 'vitest';
import {
  getMarketCloseHourET,
  getEarlyCloseHourET,
  isHoliday,
  isHalfDay,
  isTradingDay,
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
