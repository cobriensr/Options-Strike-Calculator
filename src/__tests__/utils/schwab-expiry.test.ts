import { describe, it, expect } from 'vitest';
import {
  classifySchwabExpiry,
  formatSchwabExpiryCt,
  SCHWAB_REAUTH_URGENT_MS,
  SCHWAB_REAUTH_WARN_MS,
} from '../../utils/schwab-expiry';

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.parse('2026-10-01T15:00:00Z');

describe('classifySchwabExpiry', () => {
  it('pins the thresholds at 24 h (warn) and 2 h (urgent)', () => {
    expect(SCHWAB_REAUTH_WARN_MS).toBe(24 * HOUR_MS);
    expect(SCHWAB_REAUTH_URGENT_MS).toBe(2 * HOUR_MS);
  });

  it.each([
    ['5 days left', 5 * 24 * HOUR_MS, 'ok'],
    ['24 h + 1 ms left', 24 * HOUR_MS + 1, 'ok'],
    ['exactly 24 h left', 24 * HOUR_MS, 'warn'],
    ['3 h left', 3 * HOUR_MS, 'warn'],
    ['2 h + 1 ms left', 2 * HOUR_MS + 1, 'warn'],
    ['exactly 2 h left', 2 * HOUR_MS, 'urgent'],
    ['90 min left', 90 * 60 * 1000, 'urgent'],
    ['0 ms left (not yet past)', 0, 'urgent'],
    ['1 ms past', -1, 'expired'],
    ['a day past', -24 * HOUR_MS, 'expired'],
  ] as const)('%s → %s', (_label, remainingMs, tier) => {
    expect(classifySchwabExpiry(NOW + remainingMs, NOW)).toBe(tier);
  });
});

describe('formatSchwabExpiryCt', () => {
  it.each([
    ['CDT morning', '2026-10-02T14:30:00Z', 'Fri 9:30 AM CT'],
    ['CDT evening, a UTC day ahead', '2026-10-05T00:30:00Z', 'Sun 7:30 PM CT'],
    ['CST after the fall-back', '2026-11-09T01:00:00Z', 'Sun 7:00 PM CT'],
  ])('%s → %s', (_label, iso, expected) => {
    expect(formatSchwabExpiryCt(Date.parse(iso))).toBe(expected);
  });

  it('uses plain spaces (newer ICU puts U+202F before AM/PM)', () => {
    const text = formatSchwabExpiryCt(Date.parse('2026-10-02T14:30:00Z'));
    expect(text).not.toMatch(/[\u202f\u00a0]/);
  });
});
