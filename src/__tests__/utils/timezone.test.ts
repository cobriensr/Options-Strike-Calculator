import { describe, it, expect, vi } from 'vitest';
import {
  getETTime,
  getCTTime,
  getETDateStr,
  getETDayOfWeek,
  getETDayOfWeekFromDateStr,
  getETTotalMinutes,
  getCTToETOffsetMinutes,
  convertCTToET,
  getETMarketOpenUtcIso,
} from '../../utils/timezone';

describe('timezone utilities', () => {
  // Use a fixed UTC timestamp: 2026-03-17 15:30:00 UTC
  // ET = UTC-4 (EDT) → 11:30 AM ET
  // CT = UTC-5 (CDT) → 10:30 AM CT
  const marchDate = new Date('2026-03-17T15:30:00Z');

  // Winter date: 2026-01-15 18:45:00 UTC
  // ET = UTC-5 (EST) → 1:45 PM ET
  // CT = UTC-6 (CST) → 12:45 PM CT
  const janDate = new Date('2026-01-15T18:45:00Z');

  describe('getETTime', () => {
    it('extracts hour and minute in Eastern Time (EDT)', () => {
      const { hour, minute } = getETTime(marchDate);
      expect(hour).toBe(11);
      expect(minute).toBe(30);
    });

    it('extracts hour and minute in Eastern Time (EST)', () => {
      const { hour, minute } = getETTime(janDate);
      expect(hour).toBe(13);
      expect(minute).toBe(45);
    });

    it('handles midnight UTC correctly', () => {
      // 2026-01-16 00:00:00 UTC → EST = 7:00 PM on Jan 15
      const midnight = new Date('2026-01-16T00:00:00Z');
      const { hour, minute } = getETTime(midnight);
      expect(hour).toBe(19);
      expect(minute).toBe(0);
    });
  });

  describe('getCTTime', () => {
    it('extracts hour and minute in Central Time (CDT)', () => {
      const { hour, minute } = getCTTime(marchDate);
      expect(hour).toBe(10);
      expect(minute).toBe(30);
    });

    it('extracts hour and minute in Central Time (CST)', () => {
      const { hour, minute } = getCTTime(janDate);
      expect(hour).toBe(12);
      expect(minute).toBe(45);
    });
  });

  describe('getETDateStr', () => {
    it('returns YYYY-MM-DD in Eastern Time', () => {
      expect(getETDateStr(marchDate)).toBe('2026-03-17');
    });

    it('handles date boundary when UTC date differs from ET date', () => {
      // 2026-03-18 03:00:00 UTC → still March 17 in ET (11:00 PM EDT)
      const lateUTC = new Date('2026-03-18T03:00:00Z');
      expect(getETDateStr(lateUTC)).toBe('2026-03-17');
    });
  });

  describe('getETDayOfWeek', () => {
    it('returns correct day (0=Sun, 6=Sat)', () => {
      // March 17, 2026 is a Tuesday
      expect(getETDayOfWeek(marchDate)).toBe(2);
    });

    it('returns Sunday as 0', () => {
      const sunday = new Date('2026-03-15T15:00:00Z');
      expect(getETDayOfWeek(sunday)).toBe(0);
    });

    it('returns Saturday as 6', () => {
      const saturday = new Date('2026-03-14T15:00:00Z');
      expect(getETDayOfWeek(saturday)).toBe(6);
    });

    it('falls back to date.getDay() when formatToParts returns unrecognized weekday', () => {
      const tuesday = new Date('2026-03-17T15:30:00Z');
      const originalFormatToParts = Intl.DateTimeFormat.prototype.formatToParts;

      vi.spyOn(
        Intl.DateTimeFormat.prototype,
        'formatToParts',
      ).mockImplementation(function (
        this: Intl.DateTimeFormat,
        date?: Date | number,
      ) {
        const parts = originalFormatToParts.call(this, date);
        return parts.map((part) =>
          part.type === 'weekday' ? { ...part, value: 'Unk' } : part,
        );
      });

      // Should fall back to date.getDay() which returns the local day
      expect(getETDayOfWeek(tuesday)).toBe(tuesday.getDay());

      vi.restoreAllMocks();
    });
  });

  describe('getETDayOfWeekFromDateStr', () => {
    it('returns correct weekday for a YYYY-MM-DD string (Thursday)', () => {
      // 2026-04-09 is a Thursday — dow=4
      expect(getETDayOfWeekFromDateStr('2026-04-09')).toBe(4);
    });

    it('returns correct weekday across the spring-forward DST boundary', () => {
      // 2026-03-08 is the second Sunday of March, the day EDT begins.
      // The TZ-aware helper must return 0 (Sunday) regardless of how
      // EST/EDT shifts that day. A regression that re-hardcodes -05:00
      // would still happen to get this date right, so we also assert the
      // surrounding days to lock in continuity across the boundary.
      expect(getETDayOfWeekFromDateStr('2026-03-07')).toBe(6); // Sat
      expect(getETDayOfWeekFromDateStr('2026-03-08')).toBe(0); // Sun (DST starts)
      expect(getETDayOfWeekFromDateStr('2026-03-09')).toBe(1); // Mon (EDT)
    });

    it('returns null for malformed date strings', () => {
      expect(getETDayOfWeekFromDateStr('not-a-date')).toBeNull();
      expect(getETDayOfWeekFromDateStr('2026-4-9')).toBeNull();
      expect(getETDayOfWeekFromDateStr('')).toBeNull();
    });

    it('returns null for invalid calendar dates (no rollover)', () => {
      expect(getETDayOfWeekFromDateStr('2026-02-30')).toBeNull();
      expect(getETDayOfWeekFromDateStr('2026-13-01')).toBeNull();
    });

    it('covers all seven weekdays in a single week', () => {
      // 2026-04-05 is a Sunday, 2026-04-11 is a Saturday.
      expect(getETDayOfWeekFromDateStr('2026-04-05')).toBe(0); // Sun
      expect(getETDayOfWeekFromDateStr('2026-04-06')).toBe(1); // Mon
      expect(getETDayOfWeekFromDateStr('2026-04-07')).toBe(2); // Tue
      expect(getETDayOfWeekFromDateStr('2026-04-08')).toBe(3); // Wed
      expect(getETDayOfWeekFromDateStr('2026-04-09')).toBe(4); // Thu
      expect(getETDayOfWeekFromDateStr('2026-04-10')).toBe(5); // Fri
      expect(getETDayOfWeekFromDateStr('2026-04-11')).toBe(6); // Sat
    });
  });

  describe('getETTotalMinutes', () => {
    it('returns total minutes since midnight in ET', () => {
      // 11:30 AM ET = 11 * 60 + 30 = 690
      expect(getETTotalMinutes(marchDate)).toBe(690);
    });

    it('returns 0 at midnight ET', () => {
      // Midnight ET = 5:00 AM UTC (EST)
      const midnightET = new Date('2026-01-15T05:00:00Z');
      expect(getETTotalMinutes(midnightET)).toBe(0);
    });
  });

  describe('getCTToETOffsetMinutes', () => {
    it('returns +60 minutes during EDT/CDT (summer)', () => {
      // 2026-07-15 — both zones in DST. ET=UTC-4, CT=UTC-5 → +60
      const summer = new Date('2026-07-15T15:00:00Z');
      expect(getCTToETOffsetMinutes(summer)).toBe(60);
    });

    it('returns +60 minutes during EST/CST (winter)', () => {
      // 2026-01-15 — both zones on standard time. ET=UTC-5, CT=UTC-6 → +60
      const winter = new Date('2026-01-15T15:00:00Z');
      expect(getCTToETOffsetMinutes(winter)).toBe(60);
    });

    it('correctly returns +120 inside the spring-forward DST mismatch window', () => {
      // 2026-03-08 07:30 UTC: ET has already sprung to EDT (UTC-4) and is
      // at 03:30 AM, but CT has NOT (still CST, UTC-6) and is at 01:30 AM.
      // For ~1 hour each spring, the actual ET-minus-CT wall-clock offset
      // is +120 minutes, NOT +60. The previous hardcoded `+1` would
      // silently produce wrong hours-remaining inside this window. This
      // test pins the TZ-aware behavior so a regression to a hardcoded
      // offset would fail loudly here. (FE-STATE-004)
      const dstMismatch = new Date('2026-03-08T07:30:00Z');
      expect(getCTToETOffsetMinutes(dstMismatch)).toBe(120);
    });

    it('returns +60 once both zones have completed spring-forward', () => {
      // 2026-03-08 09:00 UTC: ET = 05:00 EDT, CT = 04:00 CDT → +60. The
      // mismatch window has closed.
      const afterDst = new Date('2026-03-08T09:00:00Z');
      expect(getCTToETOffsetMinutes(afterDst)).toBe(60);
    });
  });

  describe('convertCTToET', () => {
    // Pin a fixed instant so the test is deterministic across machines.
    // 2026-04-08 17:00 UTC → mid-day, both zones in DST → offset is +60.
    const anchor = new Date('2026-04-08T17:00:00Z');

    it('converts 9:30 AM CT → 10:30 AM ET (market open)', () => {
      // Smoke-tests the canonical "9:30 CT trader entry" — must produce
      // a valid ET wall clock that downstream market-hours validation
      // accepts as being inside the session. (FE-STATE-003)
      expect(convertCTToET(9, 30, anchor)).toEqual({ hour: 10, minute: 30 });
    });

    it('converts 10:00 AM CT → 11:00 AM ET (mid-morning)', () => {
      expect(convertCTToET(10, 0, anchor)).toEqual({ hour: 11, minute: 0 });
    });

    it('converts 12:00 PM CT → 1:00 PM ET (noon)', () => {
      expect(convertCTToET(12, 0, anchor)).toEqual({ hour: 13, minute: 0 });
    });

    it('converts 2:59 PM CT → 3:59 PM ET (just before CT close)', () => {
      expect(convertCTToET(14, 59, anchor)).toEqual({ hour: 15, minute: 59 });
    });

    it('handles a date precisely at the spring-forward DST boundary', () => {
      // 2026-03-08 — DST starts in both zones at the same UTC instant.
      // 9:30 AM CDT must still convert to 10:30 AM EDT. A naive
      // `+1` offset would also pass this; the value of this test is
      // catching a future regression where someone re-introduces a
      // hardcoded UTC offset and miscalculates the boundary.
      const dstAnchor = new Date('2026-03-08T15:00:00Z'); // Sun, well after 2 AM
      expect(convertCTToET(9, 30, dstAnchor)).toEqual({
        hour: 10,
        minute: 30,
      });
    });
  });

  describe('getETMarketOpenUtcIso', () => {
    it('returns 13:30Z for an EDT date (summer)', () => {
      // 2026-04-17 is after the 2026-03-08 spring-forward → EDT (UTC-4).
      // 9:30 AM ET + 4h = 13:30 UTC.
      expect(getETMarketOpenUtcIso('2026-04-17')).toBe(
        '2026-04-17T13:30:00.000Z',
      );
    });

    it('returns 14:30Z for an EST date (winter)', () => {
      // 2026-01-15 is between the 2025 fall-back and 2026 spring-forward
      // → EST (UTC-5). 9:30 AM ET + 5h = 14:30 UTC.
      expect(getETMarketOpenUtcIso('2026-01-15')).toBe(
        '2026-01-15T14:30:00.000Z',
      );
    });

    it('returns null for malformed input', () => {
      expect(getETMarketOpenUtcIso('not-a-date')).toBeNull();
      expect(getETMarketOpenUtcIso('2026-13-01')).toBeNull();
      expect(getETMarketOpenUtcIso('')).toBeNull();
    });
  });
});
