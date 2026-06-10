import { describe, expect, it } from 'vitest';
import {
  inversionQualityBonus,
  qualityAdjustedScore,
  INVERSION_BONUS_BY_QUINTILE,
  INVERSION_BONUS_CASE_SQL,
} from '../_lib/lottery-inversion-bonus.js';

describe('inversionQualityBonus', () => {
  it('returns -5 for quintile 1', () => {
    expect(inversionQualityBonus(1)).toBe(-5);
  });
  it('returns -2 for quintile 2', () => {
    expect(inversionQualityBonus(2)).toBe(-2);
  });
  it('returns 0 for quintile 3', () => {
    expect(inversionQualityBonus(3)).toBe(0);
  });
  it('returns 3 for quintile 4', () => {
    expect(inversionQualityBonus(4)).toBe(3);
  });
  it('returns 5 for quintile 5', () => {
    expect(inversionQualityBonus(5)).toBe(5);
  });
  it('returns 0 for null', () => {
    expect(inversionQualityBonus(null)).toBe(0);
  });
  it('returns 0 for out-of-range 0', () => {
    expect(inversionQualityBonus(0)).toBe(0);
  });
  it('returns 0 for out-of-range 6', () => {
    expect(inversionQualityBonus(6)).toBe(0);
  });
});

describe('qualityAdjustedScore', () => {
  it('adds the bonus to combined score', () => {
    expect(qualityAdjustedScore(18, 5)).toBe(23);
    expect(qualityAdjustedScore(18, 1)).toBe(13);
    expect(qualityAdjustedScore(18, null)).toBe(18);
  });
});

describe('INVERSION_BONUS_BY_QUINTILE', () => {
  it('exposes the mapping as a readonly record', () => {
    expect(INVERSION_BONUS_BY_QUINTILE).toEqual({
      1: -5,
      2: -2,
      3: 0,
      4: 3,
      5: 5,
    });
  });
});

describe('INVERSION_BONUS_CASE_SQL (bonus-sql-parity)', () => {
  // The qas SQL filter in /api/lottery-finder + /api/lottery-finder-ticker-counts
  // gates on the SAME displayed score the row badge derives via
  // qualityAdjustedScore. The in-SQL bonus is a raw CASE string that MUST mirror
  // INVERSION_BONUS_BY_QUINTILE exactly. This test fails loudly if the JS map
  // and the SQL CASE ever drift.
  it('is the exact CASE on s.inversion_quintile mirroring the JS map (NULL → 0)', () => {
    expect(INVERSION_BONUS_CASE_SQL).toBe(
      'CASE s.inversion_quintile WHEN 1 THEN -5 WHEN 2 THEN -2 ' +
        'WHEN 3 THEN 0 WHEN 4 THEN 3 WHEN 5 THEN 5 ELSE 0 END',
    );
  });

  it('every quintile branch + the ELSE encodes the same integer as the JS map', () => {
    for (const [q, bonus] of Object.entries(INVERSION_BONUS_BY_QUINTILE)) {
      expect(INVERSION_BONUS_CASE_SQL).toContain(`WHEN ${q} THEN ${bonus} `);
    }
    // NULL / out-of-range quintile → ELSE 0 (matches inversionQualityBonus).
    expect(INVERSION_BONUS_CASE_SQL).toContain('ELSE 0 END');
  });
});
