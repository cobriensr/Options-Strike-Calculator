import { describe, it, expect } from 'vitest';
import { computeCapturedAtIso } from '../../utils/trace-live-tz';

describe('computeCapturedAtIso', () => {
  it('produces a UTC ISO during EDT (April, ET = UTC-4)', () => {
    // 2026-04-22 is mid-April -- well inside EDT (DST in effect).
    // 09:35 CT = 10:35 ET = 14:35 UTC.
    expect(computeCapturedAtIso('2026-04-22', 9, 35)).toBe(
      '2026-04-22T14:35:00.000Z',
    );
  });

  it('produces a UTC ISO during EST (January, ET = UTC-5)', () => {
    // 2026-01-15 is mid-January -- EST in effect.
    // 09:35 CT = 10:35 ET = 15:35 UTC.
    expect(computeCapturedAtIso('2026-01-15', 9, 35)).toBe(
      '2026-01-15T15:35:00.000Z',
    );
  });

  it('handles the EST -> EDT spring-forward transition correctly', () => {
    // 2026-03-08 is the Sunday DST transition. The 09:35 CT slot is
    // after 2 AM ET, so EDT (UTC-4) applies.
    // 09:35 CT = 10:35 EDT = 14:35 UTC.
    expect(computeCapturedAtIso('2026-03-08', 9, 35)).toBe(
      '2026-03-08T14:35:00.000Z',
    );
    // The Friday before is still EST.
    expect(computeCapturedAtIso('2026-03-06', 9, 35)).toBe(
      '2026-03-06T15:35:00.000Z',
    );
  });

  it('handles the EDT -> EST fall-back transition correctly', () => {
    // 2026-11-01 is the Sunday fall-back. After 2 AM, EST applies.
    expect(computeCapturedAtIso('2026-11-01', 9, 35)).toBe(
      '2026-11-01T15:35:00.000Z',
    );
    // The Friday before is still EDT (UTC-4): 09:35 CT = 14:35 UTC.
    expect(computeCapturedAtIso('2026-10-30', 9, 35)).toBe(
      '2026-10-30T14:35:00.000Z',
    );
  });

  it('handles a holiday boundary (no special-casing needed)', () => {
    // 2026-07-03 is an observed Independence Day full closure -- but the
    // helper takes (date, time) literally and does NOT consult the
    // holiday calendar. Backfill skips holidays via the GEX query
    // returning null. Verify the literal computation is correct.
    expect(computeCapturedAtIso('2026-07-03', 9, 35)).toBe(
      '2026-07-03T14:35:00.000Z',
    );
  });

  it('handles minute=0 and other edge values', () => {
    expect(computeCapturedAtIso('2026-04-22', 8, 0)).toBe(
      '2026-04-22T13:00:00.000Z',
    );
    expect(computeCapturedAtIso('2026-04-22', 14, 55)).toBe(
      '2026-04-22T19:55:00.000Z',
    );
  });

  it('produces "Invalid Date" output for malformed date input', () => {
    // Caller is expected to validate before calling. We assert the
    // observable behavior: malformed input throws (RangeError) rather
    // than silently returning a wrong instant.
    expect(() => computeCapturedAtIso('not-a-date', 9, 35)).toThrow();
  });
});
