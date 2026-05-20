import { describe, expect, it } from 'vitest';
import {
  inversionQualityBonus,
  qualityAdjustedScore,
  INVERSION_BONUS_BY_QUINTILE,
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
