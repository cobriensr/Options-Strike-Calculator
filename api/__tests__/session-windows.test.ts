// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  lastSessionOpenUtc,
  sessionOpenUtcForDate,
} from '../_lib/session-windows.js';

// ============================================================
// lastSessionOpenUtc
// ============================================================

describe('lastSessionOpenUtc', () => {
  it('returns the same-day 13:30 UTC anchor during CDT for an after-open instant', () => {
    // 2026-04-30 is in CDT. 09:30 CDT == 14:30 UTC. We're past 08:30 CT.
    const out = lastSessionOpenUtc(new Date('2026-04-30T14:30:00Z'));
    expect(out).toBe('2026-04-30T13:30:00.000Z');
  });

  it('returns null when called before today 08:30 CT (pre-market)', () => {
    // 2026-04-30 11:00 UTC = 06:00 CDT — before 08:30 CT.
    const out = lastSessionOpenUtc(new Date('2026-04-30T11:00:00Z'));
    expect(out).toBeNull();
  });

  it('returns 14:30 UTC during CST (winter, e.g. January)', () => {
    // 2026-01-15 is in CST. 08:30 CST == 14:30 UTC. We're at 16:00 UTC = 10:00 CST.
    const out = lastSessionOpenUtc(new Date('2026-01-15T16:00:00Z'));
    expect(out).toBe('2026-01-15T14:30:00.000Z');
  });

  it('returns null on a winter pre-market instant', () => {
    // 2026-01-15 13:00 UTC == 07:00 CST — pre-market.
    const out = lastSessionOpenUtc(new Date('2026-01-15T13:00:00Z'));
    expect(out).toBeNull();
  });

  it('returns the candidate exactly at 08:30 CT', () => {
    // 13:30 UTC on 2026-04-30 IS 08:30 CDT.
    const out = lastSessionOpenUtc(new Date('2026-04-30T13:30:00Z'));
    expect(out).toBe('2026-04-30T13:30:00.000Z');
  });
});

// ============================================================
// sessionOpenUtcForDate
// ============================================================

describe('sessionOpenUtcForDate', () => {
  it('returns 12:30 UTC for an EDT date', () => {
    // 2026-04-30 is in EDT. 08:30 EDT == 12:30 UTC.
    expect(sessionOpenUtcForDate('2026-04-30')).toBe(
      '2026-04-30T12:30:00.000Z',
    );
  });

  it('returns 13:30 UTC for an EST date', () => {
    // 2026-01-15 is in EST. 08:30 EST == 13:30 UTC.
    expect(sessionOpenUtcForDate('2026-01-15')).toBe(
      '2026-01-15T13:30:00.000Z',
    );
  });

  it('returns a string in well-formed ISO 8601 UTC shape', () => {
    const out = sessionOpenUtcForDate('2026-06-01');
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:30:00\.000Z$/);
  });
});
