import { describe, it, expect } from 'vitest';
import { validateMarketTime } from '../calculator';

describe('validateMarketTime: boundary tests (all times Eastern)', () => {
  // Market hours: 9:30 AM ET - 4:00 PM ET

  // ---- Pre-market: should reject ----
  it('rejects 0:00 (midnight)', () => {
    const r = validateMarketTime(0, 0);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('Before market open');
  });

  it('rejects 9:00 AM', () => {
    const r = validateMarketTime(9, 0);
    expect(r.valid).toBe(false);
  });

  it('rejects 9:29 AM (one minute before open)', () => {
    const r = validateMarketTime(9, 29);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('Before market open');
  });

  // ---- Exact open: should accept ----
  it('accepts 9:30 AM (market open) with 6.5h remaining', () => {
    const r = validateMarketTime(9, 30);
    expect(r.valid).toBe(true);
    expect(r.hoursRemaining).toBeCloseTo(6.5, 4);
  });

  // ---- Just after open: should accept ----
  it('accepts 9:31 AM with ~6.483h remaining', () => {
    const r = validateMarketTime(9, 31);
    expect(r.valid).toBe(true);
    expect(r.hoursRemaining).toBeCloseTo(6.5 - 1 / 60, 3);
  });

  // ---- Mid-day: should accept ----
  it('accepts 10:00 AM with 6h remaining', () => {
    const r = validateMarketTime(10, 0);
    expect(r.valid).toBe(true);
    expect(r.hoursRemaining).toBeCloseTo(6, 4);
  });

  it('accepts 12:00 PM (noon) with 4h remaining', () => {
    const r = validateMarketTime(12, 0);
    expect(r.valid).toBe(true);
    expect(r.hoursRemaining).toBeCloseTo(4, 4);
  });

  it('accepts 1:00 PM with 3h remaining', () => {
    const r = validateMarketTime(13, 0);
    expect(r.valid).toBe(true);
    expect(r.hoursRemaining).toBeCloseTo(3, 4);
  });

  it('accepts 2:30 PM with 1.5h remaining', () => {
    const r = validateMarketTime(14, 30);
    expect(r.valid).toBe(true);
    expect(r.hoursRemaining).toBeCloseTo(1.5, 4);
  });

  // ---- Near close: should accept ----
  it('accepts 3:30 PM with 0.5h remaining', () => {
    const r = validateMarketTime(15, 30);
    expect(r.valid).toBe(true);
    expect(r.hoursRemaining).toBeCloseTo(0.5, 4);
  });

  it('accepts 3:59 PM with ~0.0167h remaining', () => {
    const r = validateMarketTime(15, 59);
    expect(r.valid).toBe(true);
    expect(r.hoursRemaining).toBeCloseTo(1 / 60, 3);
  });

  // ---- Exact close: should reject ----
  it('rejects 4:00 PM (market close)', () => {
    const r = validateMarketTime(16, 0);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('close');
  });

  // ---- Post-market: should reject ----
  it('rejects 4:01 PM', () => {
    const r = validateMarketTime(16, 1);
    expect(r.valid).toBe(false);
  });

  it('rejects 5:00 PM', () => {
    const r = validateMarketTime(17, 0);
    expect(r.valid).toBe(false);
  });

  it('rejects 8:00 PM', () => {
    const r = validateMarketTime(20, 0);
    expect(r.valid).toBe(false);
  });

  it('rejects 23:59 (end of day)', () => {
    const r = validateMarketTime(23, 59);
    expect(r.valid).toBe(false);
  });
});

describe('validateMarketTime: hours remaining precision', () => {
  it('11:00 AM ET → 5.0 hours remaining', () => {
    const r = validateMarketTime(11, 0);
    expect(r.valid).toBe(true);
    expect(r.hoursRemaining).toBe(5);
  });

  it('11:46 AM ET → 4h 14m → 4.2333h remaining', () => {
    const r = validateMarketTime(11, 46);
    expect(r.valid).toBe(true);
    expect(r.hoursRemaining).toBeCloseTo((16 * 60 - (11 * 60 + 46)) / 60, 4);
  });

  it('12:30 PM ET → 3.5h remaining (spec example)', () => {
    const r = validateMarketTime(12, 30);
    expect(r.valid).toBe(true);
    expect(r.hoursRemaining).toBeCloseTo(3.5, 4);
  });

  it('exact minutes calculation: every minute from open to close', () => {
    // Verify hours remaining is monotonically decreasing
    let prevHours = Infinity;
    for (let totalMinutes = 570; totalMinutes < 960; totalMinutes++) {
      const hour = Math.floor(totalMinutes / 60);
      const minute = totalMinutes % 60;
      const r = validateMarketTime(hour, minute);
      expect(r.valid).toBe(true);
      expect(r.hoursRemaining).toBeLessThan(prevHours);
      prevHours = r.hoursRemaining!;
    }
  });
});
