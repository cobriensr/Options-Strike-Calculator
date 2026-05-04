import { describe, expect, it } from 'vitest';
import { ctSessionBounds, ctToUtc } from '../ct-window.js';

/**
 * Regression: the prior in-component implementation used
 * `new Date('YYYY-MM-DDTHH:mm:ss')` (no `Z`), which JS interprets in
 * the browser's local TZ. For a CT user that double-counted the
 * offset, producing slider bounds of 13:30 → 20:00 CT instead of
 * 08:30 → 15:00 CT.
 *
 * The fix anchors the guess in UTC and shifts by the diff between
 * what CT reads and what we wanted CT to read. These tests pin the
 * exact UTC outputs so a future "simplification" can't reintroduce
 * the bug.
 */

describe('ctToUtc', () => {
  describe('CDT window (Mar–Nov, UTC-5)', () => {
    it('08:30 CT on 2026-05-01 → 13:30 UTC', () => {
      expect(ctToUtc('2026-05-01', 8, 30)).toBe('2026-05-01T13:30:00.000Z');
    });

    it('15:00 CT on 2026-05-01 → 20:00 UTC', () => {
      expect(ctToUtc('2026-05-01', 15, 0)).toBe('2026-05-01T20:00:00.000Z');
    });

    it('14:35 CT on 2026-05-01 → 19:35 UTC (slider mid-session)', () => {
      expect(ctToUtc('2026-05-01', 14, 35)).toBe('2026-05-01T19:35:00.000Z');
    });

    it('00:00 CT on 2026-05-01 → 05:00 UTC', () => {
      expect(ctToUtc('2026-05-01', 0, 0)).toBe('2026-05-01T05:00:00.000Z');
    });
  });

  describe('CST window (Nov–Mar, UTC-6)', () => {
    it('08:30 CT on 2026-01-15 → 14:30 UTC', () => {
      expect(ctToUtc('2026-01-15', 8, 30)).toBe('2026-01-15T14:30:00.000Z');
    });

    it('15:00 CT on 2026-01-15 → 21:00 UTC', () => {
      expect(ctToUtc('2026-01-15', 15, 0)).toBe('2026-01-15T21:00:00.000Z');
    });
  });

  describe('DST transition days', () => {
    it('handles spring-forward (2026-03-08, CST→CDT)', () => {
      // 2026-03-08 02:00 CST = 03:00 CDT. The session window is fully
      // in CDT (08:30 → 15:00). Expect CDT-style offsets.
      expect(ctToUtc('2026-03-08', 8, 30)).toBe('2026-03-08T13:30:00.000Z');
    });

    it('handles fall-back (2026-11-01, CDT→CST)', () => {
      // 2026-11-01 02:00 CDT → 01:00 CST (clock falls back at 02:00).
      // The session window starts after the transition, so 08:30 is
      // CST → 14:30 UTC.
      expect(ctToUtc('2026-11-01', 8, 30)).toBe('2026-11-01T14:30:00.000Z');
    });
  });
});

describe('ctSessionBounds', () => {
  it('returns 08:30 CT min and 15:00 CT max for a CDT date', () => {
    const { min, max } = ctSessionBounds('2026-05-01');
    expect(min).toBe('2026-05-01T13:30:00.000Z');
    expect(max).toBe('2026-05-01T20:00:00.000Z');
  });

  it('returns CST-shifted bounds for a winter date', () => {
    const { min, max } = ctSessionBounds('2026-01-15');
    expect(min).toBe('2026-01-15T14:30:00.000Z');
    expect(max).toBe('2026-01-15T21:00:00.000Z');
  });
});
