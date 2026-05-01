// @vitest-environment node

/**
 * Unit tests for api/_lib/format-helpers.ts (Phase 1c).
 *
 * Covers boundary cases at scale thresholds and parity with the
 * pre-existing reinvented homes (futures-context, uw-deltas,
 * microstructure-signals, darkpool). Adoption (Phase 5d) must produce
 * identical Claude-prompt output, so each test pins a known string.
 */

import { describe, it, expect } from 'vitest';
import {
  fmtPct,
  fmtPrice,
  formatSigned,
  fmtOI,
  fmtDp,
  formatDollarAbbrev,
} from '../_lib/format-helpers.js';

describe('fmtPct', () => {
  it('returns N/A for null / undefined / non-finite', () => {
    expect(fmtPct(null)).toBe('N/A');
    expect(fmtPct(undefined)).toBe('N/A');
    expect(fmtPct(Number.NaN)).toBe('N/A');
    expect(fmtPct(Number.POSITIVE_INFINITY)).toBe('N/A');
  });

  it('default 2 digits, leading + on non-negative (futures-context shape)', () => {
    expect(fmtPct(2.5)).toBe('+2.50%');
    expect(fmtPct(0)).toBe('+0.00%');
    expect(fmtPct(-1)).toBe('-1.00%');
  });

  it('honors digits override', () => {
    expect(fmtPct(2.5, { digits: 1 })).toBe('+2.5%');
  });

  it('fromDecimal multiplies by 100 (uw-deltas / db-flow shape)', () => {
    expect(fmtPct(0.025, { fromDecimal: true, digits: 1 })).toBe('+2.5%');
    expect(fmtPct(-0.012, { fromDecimal: true, digits: 1 })).toBe('-1.2%');
  });
});

describe('fmtPrice', () => {
  it('returns N/A for null / non-finite', () => {
    expect(fmtPrice(null)).toBe('N/A');
    expect(fmtPrice(Number.NaN)).toBe('N/A');
  });

  it('formats with US-locale grouping at 2 decimals by default', () => {
    expect(fmtPrice(5825.5)).toBe('5,825.50');
    expect(fmtPrice(0.5)).toBe('0.50');
  });

  it('honors digits override', () => {
    expect(fmtPrice(5825.5, { digits: 0 })).toBe('5,826');
    expect(fmtPrice(1234567.89, { digits: 4 })).toBe('1,234,567.8900');
  });
});

describe('formatSigned', () => {
  it('returns N/A for null / non-finite', () => {
    expect(formatSigned(null)).toBe('N/A');
    expect(formatSigned(Number.NaN)).toBe('N/A');
  });

  it('default 2 digits with leading + on non-negative', () => {
    expect(formatSigned(0)).toBe('+0.00');
    expect(formatSigned(2)).toBe('+2.00');
    expect(formatSigned(-1.234)).toBe('-1.23');
  });

  it('honors digits override', () => {
    expect(formatSigned(-1.234, { digits: 3 })).toBe('-1.234');
    expect(formatSigned(7, { digits: 0 })).toBe('+7');
  });
});

describe('fmtOI', () => {
  it('returns N/A for null / non-finite', () => {
    expect(fmtOI(null)).toBe('N/A');
    expect(fmtOI(Number.NaN)).toBe('N/A');
  });

  it('formats raw integer < 1K', () => {
    expect(fmtOI(0)).toBe('0');
    expect(fmtOI(950)).toBe('950');
    expect(fmtOI(999)).toBe('999');
  });

  it('formats K-scale at the 1_000 boundary', () => {
    expect(fmtOI(1_000)).toBe('1.0K');
    expect(fmtOI(1_500)).toBe('1.5K');
    expect(fmtOI(999_999)).toBe('1000.0K');
  });

  it('formats M-scale at the 1_000_000 boundary', () => {
    expect(fmtOI(1_000_000)).toBe('1.0M');
    expect(fmtOI(5_400_000)).toBe('5.4M');
    expect(fmtOI(12_345_678)).toBe('12.3M');
  });

  it('handles negative values by sign-prefixing magnitude', () => {
    expect(fmtOI(-1_500)).toBe('-1.5K');
  });
});

describe('fmtDp', () => {
  it('returns N/A for null / non-finite', () => {
    expect(fmtDp(null)).toBe('N/A');
    expect(fmtDp(Number.NaN)).toBe('N/A');
  });

  it('returns absolute value for sub-1K', () => {
    expect(fmtDp(0)).toBe('0');
    expect(fmtDp(750)).toBe('750');
    expect(fmtDp(-750)).toBe('750');
  });

  it('K-scale uses 0 decimals (matches darkpool.ts)', () => {
    expect(fmtDp(1_000)).toBe('1K');
    expect(fmtDp(5_500)).toBe('6K');
    expect(fmtDp(999_999)).toBe('1000K');
  });

  it('M-scale at 1M boundary', () => {
    expect(fmtDp(1_000_000)).toBe('1.0M');
    expect(fmtDp(12_500_000)).toBe('12.5M');
  });

  it('B-scale at 1B boundary', () => {
    expect(fmtDp(1_000_000_000)).toBe('1.0B');
    expect(fmtDp(1_200_000_000)).toBe('1.2B');
  });
});

describe('formatDollarAbbrev', () => {
  it('returns N/A for null / non-finite', () => {
    expect(formatDollarAbbrev(null)).toBe('N/A');
    expect(formatDollarAbbrev(Number.NaN)).toBe('N/A');
  });

  it('sub-1K is $XXX with 0 decimals', () => {
    expect(formatDollarAbbrev(0)).toBe('$0');
    expect(formatDollarAbbrev(950)).toBe('$950');
    expect(formatDollarAbbrev(-950)).toBe('-$950');
  });

  it('K-scale: 0 decimals, sign preserved', () => {
    expect(formatDollarAbbrev(1_000)).toBe('$1K');
    expect(formatDollarAbbrev(-5_500)).toBe('-$6K');
  });

  it('M-scale: 1 decimal', () => {
    expect(formatDollarAbbrev(1_000_000)).toBe('$1.0M');
    expect(formatDollarAbbrev(12_500_000)).toBe('$12.5M');
    expect(formatDollarAbbrev(-2_400_000)).toBe('-$2.4M');
  });

  it('B-scale: 2 decimals (asymmetric precision matches uw-deltas)', () => {
    expect(formatDollarAbbrev(1_000_000_000)).toBe('$1.00B');
    expect(formatDollarAbbrev(1_500_000_000)).toBe('$1.50B');
    expect(formatDollarAbbrev(-2_345_000_000)).toBe('-$2.35B');
  });
});
