// @vitest-environment node

/**
 * Regression test for the timezone bug found 2026-05-10.
 *
 * computeCapturedAt previously relied on the Railway container being
 * configured TZ=America/Chicago. When deployed with the default UTC
 * TZ, every backfilled captured_at was shifted 5 hours earlier — which
 * silently corrupted 5/4-5/7 snapshot timestamps and caused ~$50 of
 * stale Claude reads in the auto-playbook backfill.
 *
 * This suite locks the expected UTC ISO output for known CT inputs
 * regardless of the test runner's local TZ.
 */

import { describe, it, expect } from 'vitest';
import { computeCapturedAt, isCtInRth } from '../dates.js';

describe('computeCapturedAt: produces UTC ISO from a CT wall clock', () => {
  it('CDT (DST active in May): 08:30 CT → 13:30 UTC', () => {
    // May 6, 2026 is in CDT (UTC-5).
    expect(computeCapturedAt('2026-05-06', '08:30')).toBe(
      '2026-05-06T13:30:00.000Z',
    );
  });

  it('CDT end of session: 15:00 CT → 20:00 UTC', () => {
    expect(computeCapturedAt('2026-05-06', '15:00')).toBe(
      '2026-05-06T20:00:00.000Z',
    );
  });

  it('CDT first analyzable slot: 08:30 CT → 13:30 UTC (different date)', () => {
    expect(computeCapturedAt('2026-05-12', '08:30')).toBe(
      '2026-05-12T13:30:00.000Z',
    );
  });

  it('CST (DST inactive in November): 08:30 CT → 14:30 UTC', () => {
    // November 17, 2025 is after the DST end (Nov 2, 2025).
    expect(computeCapturedAt('2025-11-17', '08:30')).toBe(
      '2025-11-17T14:30:00.000Z',
    );
  });

  it('Late slot in CST: 15:00 CT → 21:00 UTC', () => {
    expect(computeCapturedAt('2025-12-15', '15:00')).toBe(
      '2025-12-15T21:00:00.000Z',
    );
  });

  it('Pre-DST 2026 (Jan): CST in effect, 11:30 CT → 17:30 UTC', () => {
    expect(computeCapturedAt('2026-01-15', '11:30')).toBe(
      '2026-01-15T17:30:00.000Z',
    );
  });

  it('Post-DST 2026 (March 8, day DST starts): 08:30 CT → 13:30 UTC', () => {
    // 2026-03-08 02:00 CST → 03:00 CDT, so 08:30 falls in CDT.
    expect(computeCapturedAt('2026-03-08', '08:30')).toBe(
      '2026-03-08T13:30:00.000Z',
    );
  });

  it('throws on malformed date input', () => {
    expect(() => computeCapturedAt('not-a-date', '08:30')).toThrow();
  });

  it('throws on malformed time input', () => {
    expect(() => computeCapturedAt('2026-05-06', 'xx:yy')).toThrow();
  });
});

describe('isCtInRth: CT wall-clock RTH gate', () => {
  it('true at 08:30 CDT (RTH open) Mon-Fri', () => {
    // 2026-05-06 13:30 UTC = 08:30 CDT (Wednesday).
    expect(isCtInRth(new Date('2026-05-06T13:30:00Z'))).toBe(true);
  });

  it('true at 15:00 CDT (RTH close) Mon-Fri', () => {
    // 2026-05-06 20:00 UTC = 15:00 CDT.
    expect(isCtInRth(new Date('2026-05-06T20:00:00Z'))).toBe(true);
  });

  it('false at 08:29 CDT (one min before open)', () => {
    // 2026-05-06 13:29 UTC = 08:29 CDT.
    expect(isCtInRth(new Date('2026-05-06T13:29:00Z'))).toBe(false);
  });

  it('false at 15:01 CDT (one min after close)', () => {
    expect(isCtInRth(new Date('2026-05-06T20:01:00Z'))).toBe(false);
  });

  it('false at 03:30 CDT (pre-market — the bug case)', () => {
    // This is the catastrophic case: backfill ran at 03:30 CT, the
    // auto-playbook gate must reject these.
    expect(isCtInRth(new Date('2026-05-06T08:30:00Z'))).toBe(false);
  });

  it('false on Saturday at noon CT', () => {
    // 2026-05-09 17:00 UTC = 12:00 CDT Saturday.
    expect(isCtInRth(new Date('2026-05-09T17:00:00Z'))).toBe(false);
  });

  it('CST-aware: 08:30 CST in November is correctly inside RTH', () => {
    // 2025-11-17 14:30 UTC = 08:30 CST (Monday after DST end).
    expect(isCtInRth(new Date('2025-11-17T14:30:00Z'))).toBe(true);
  });

  it('CST-aware: 13:30 UTC in November = 07:30 CST (before open)', () => {
    expect(isCtInRth(new Date('2025-11-17T13:30:00Z'))).toBe(false);
  });
});
