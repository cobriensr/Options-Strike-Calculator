import { describe, it, expect, vi } from 'vitest';
import {
  getETTime,
  getCTTime,
  getETDateStr,
  getETDayOfWeek,
  getETTotalMinutes,
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
});
