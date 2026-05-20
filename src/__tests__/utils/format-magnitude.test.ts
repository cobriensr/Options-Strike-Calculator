/**
 * Unit tests for the Greek Heatmap section's compact magnitude
 * formatters. Three flavors share the same scale-and-suffix engine
 * but differ in sign / currency / scale-offset semantics — easy to
 * regress when refactored.
 */

import { describe, expect, it } from 'vitest';

import {
  formatNetGexShort,
  formatOI,
  formatPremiumShort,
  formatSignedShort,
} from '../../utils/format-magnitude';

describe('formatSignedShort', () => {
  it('renders zero without a sign', () => {
    expect(formatSignedShort(0)).toBe('0');
  });

  it('always sign-prefixes non-zero values', () => {
    expect(formatSignedShort(290)).toBe('+290');
    expect(formatSignedShort(-290)).toBe('-290');
  });

  it('scales K / M / B with appropriate decimal places', () => {
    expect(formatSignedShort(1_500)).toBe('+2K'); // (1500/1000).toFixed(0) = "2" (rounds up)
    expect(formatSignedShort(1_499)).toBe('+1K');
    expect(formatSignedShort(67_300_000)).toBe('+67.3M');
    expect(formatSignedShort(-4_044_250_000_000)).toBe('-4044.25B');
  });

  it('handles fractional values inside the unit band', () => {
    expect(formatSignedShort(491)).toBe('+491');
    expect(formatSignedShort(-491)).toBe('-491');
  });
});

describe('formatPremiumShort', () => {
  it('renders zero as "$0" with no sign', () => {
    expect(formatPremiumShort(0)).toBe('$0');
  });

  it('omits "+" for positive but prefixes "-" for negative', () => {
    expect(formatPremiumShort(1_716_000)).toBe('$1.72M');
    expect(formatPremiumShort(-21_410_000)).toBe('-$21.41M');
  });

  it('uses two decimals at M and B, one decimal at K', () => {
    expect(formatPremiumShort(1_500)).toBe('$1.5K');
    expect(formatPremiumShort(1_500_000_000)).toBe('$1.50B');
  });
});

describe('formatNetGexShort', () => {
  it('renders zero as "$0"', () => {
    expect(formatNetGexShort(0)).toBe('$0');
  });

  it('scales the K-already-applied input correctly', () => {
    // 1591.2 netGexK = $1.59M of net gamma.
    expect(formatNetGexShort(1591.2)).toBe('+$1.6M');
    // 142672.6 netGexK = $142.7M.
    expect(formatNetGexShort(142672.6)).toBe('+$142.7M');
    // 2_500_000 netGexK = $2.5B.
    expect(formatNetGexShort(2_500_000)).toBe('+$2.50B');
  });

  it('signs negative values', () => {
    expect(formatNetGexShort(-1_500_000)).toBe('-$1.50B');
    expect(formatNetGexShort(-0.5)).toBe('-$500');
  });

  it('renders sub-1K values in raw dollars', () => {
    expect(formatNetGexShort(0.5)).toBe('+$500');
  });
});

describe('formatOI', () => {
  it('returns number as-is for values below 1000', () => {
    expect(formatOI(0)).toBe('0');
    expect(formatOI(1)).toBe('1');
    expect(formatOI(500)).toBe('500');
    expect(formatOI(999)).toBe('999');
  });

  it('returns K suffix for values >= 1000', () => {
    expect(formatOI(1000)).toBe('1.0K');
    expect(formatOI(1500)).toBe('1.5K');
    expect(formatOI(10000)).toBe('10.0K');
    expect(formatOI(25300)).toBe('25.3K');
  });

  it('rounds to one decimal place', () => {
    expect(formatOI(1234)).toBe('1.2K');
    expect(formatOI(1250)).toBe('1.3K'); // 1.250 → toFixed(1) → "1.3" (JS rounds 5 up)
    expect(formatOI(1260)).toBe('1.3K');
  });
});
