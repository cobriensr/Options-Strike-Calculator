import { describe, it, expect } from 'vitest';
import {
  getMarketCloseHourET,
  getEarlyCloseHourET,
} from '../data/eventCalendar';

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
