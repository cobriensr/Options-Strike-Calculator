import { describe, it, expect } from 'vitest';
import {
  fmtPrice,
  fmtDollar,
  pnlColor,
} from '../../../components/FuturesCalculator/formatters';
import { theme } from '../../../themes';

describe('fmtPrice', () => {
  it('formats an integer with two decimals and no currency symbol', () => {
    expect(fmtPrice(100)).toBe('100.00');
  });

  it('formats a decimal with two-decimal precision', () => {
    expect(fmtPrice(100.5)).toBe('100.50');
  });

  it('rounds to two decimal places', () => {
    expect(fmtPrice(100.555)).toBe('100.56');
  });

  it('inserts locale separators for large values', () => {
    expect(fmtPrice(1_234_567.89)).toBe('1,234,567.89');
  });

  it('handles zero', () => {
    expect(fmtPrice(0)).toBe('0.00');
  });

  it('preserves negative sign for negative values', () => {
    expect(fmtPrice(-42.5)).toBe('-42.50');
  });
});

describe('fmtDollar', () => {
  it('formats a positive value with $ prefix and no sign by default', () => {
    expect(fmtDollar(100)).toBe('$100.00');
  });

  it('formats a negative value with leading minus sign', () => {
    expect(fmtDollar(-100)).toBe('-$100.00');
  });

  it('formats zero as $0.00 (no sign)', () => {
    expect(fmtDollar(0)).toBe('$0.00');
  });

  it('adds explicit + sign for positive when alwaysSign is true', () => {
    expect(fmtDollar(100, true)).toBe('+$100.00');
  });

  it('adds explicit + sign for zero when alwaysSign is true', () => {
    // 0 >= 0 is true → alwaysSign shows '+'
    expect(fmtDollar(0, true)).toBe('+$0.00');
  });

  it('still uses minus for negative when alwaysSign is true', () => {
    expect(fmtDollar(-250.75, true)).toBe('-$250.75');
  });

  it('inserts locale separators in the absolute value', () => {
    expect(fmtDollar(12_345.67)).toBe('$12,345.67');
  });

  it('inserts locale separators for large negatives', () => {
    expect(fmtDollar(-1_000_000)).toBe('-$1,000,000.00');
  });

  it('rounds to two decimals', () => {
    expect(fmtDollar(9.999)).toBe('$10.00');
  });
});

describe('pnlColor', () => {
  it('returns green for positive values', () => {
    expect(pnlColor(10)).toBe(theme.green);
  });

  it('returns red for negative values', () => {
    expect(pnlColor(-10)).toBe(theme.red);
  });

  it('returns textMuted for zero', () => {
    expect(pnlColor(0)).toBe(theme.textMuted);
  });

  it('returns green for fractional positives', () => {
    expect(pnlColor(0.01)).toBe(theme.green);
  });

  it('returns red for fractional negatives', () => {
    expect(pnlColor(-0.01)).toBe(theme.red);
  });
});
