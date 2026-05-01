/**
 * Tests for `flow-formatters` — pure number/currency/pct formatters
 * shared by the options-flow tables.
 *
 * These functions are pure and deterministic, so the tests focus on:
 *   - the four scale boundaries (sub-thousand, K, M, B)
 *   - sign handling (positive, negative, zero)
 *   - null / NaN / Infinity coalescing
 *   - the parameterized options (kDigits, signed, digits)
 *
 * Where the legacy private formatters in `OptionsFlowTable` and
 * `WhalePositioningTable` produced specific strings, those exact strings
 * are asserted here so the Phase 2a swap is a no-visible-diff change.
 */

import { describe, it, expect } from 'vitest';
import {
  formatPremium,
  formatPct,
  formatAskPct,
  formatGex,
  formatSignedInt,
} from '../../utils/flow-formatters';

describe('formatPremium', () => {
  describe('scale branches (default kDigits = 1)', () => {
    it('renders billions-range values via the millions branch', () => {
      // No explicit billions branch — premium magnitudes don't need it.
      expect(formatPremium(2_500_000_000)).toBe('$2500.0M');
    });

    it('renders millions with one decimal', () => {
      expect(formatPremium(206_500_000)).toBe('$206.5M');
      expect(formatPremium(1_400_000)).toBe('$1.4M');
      expect(formatPremium(1_000_000)).toBe('$1.0M');
    });

    it('renders thousands with one decimal by default', () => {
      expect(formatPremium(1_000)).toBe('$1.0K');
      expect(formatPremium(850_000)).toBe('$850.0K');
      expect(formatPremium(999_999)).toBe('$1000.0K');
    });

    it('renders sub-thousand values as a rounded dollar amount', () => {
      expect(formatPremium(999)).toBe('$999');
      expect(formatPremium(1)).toBe('$1');
      expect(formatPremium(123.7)).toBe('$124');
    });
  });

  describe('kDigits = 0 (Whale-flow density)', () => {
    it('drops decimals from the K branch', () => {
      expect(formatPremium(850_000, { kDigits: 0 })).toBe('$850K');
      expect(formatPremium(1_000, { kDigits: 0 })).toBe('$1K');
    });

    it('does not affect the M branch', () => {
      expect(formatPremium(1_400_000, { kDigits: 0 })).toBe('$1.4M');
    });
  });

  describe('zero / negative / non-finite coalescing', () => {
    it('renders zero as "$0"', () => {
      expect(formatPremium(0)).toBe('$0');
    });

    it('renders negative inputs as "$0"', () => {
      // Premium magnitudes are non-negative; coalesce defensively.
      expect(formatPremium(-1)).toBe('$0');
      expect(formatPremium(-1_000_000)).toBe('$0');
    });

    it('renders NaN / Infinity as "$0"', () => {
      expect(formatPremium(Number.NaN)).toBe('$0');
      expect(formatPremium(Number.POSITIVE_INFINITY)).toBe('$0');
      expect(formatPremium(Number.NEGATIVE_INFINITY)).toBe('$0');
    });
  });

  describe('boundary values at scale thresholds', () => {
    it('sub-thousand → K transition at exactly 1000', () => {
      expect(formatPremium(999)).toBe('$999');
      expect(formatPremium(1_000)).toBe('$1.0K');
    });

    it('K → M transition at exactly 1_000_000', () => {
      expect(formatPremium(999_999)).toBe('$1000.0K');
      expect(formatPremium(1_000_000)).toBe('$1.0M');
    });
  });
});

describe('formatPct', () => {
  describe('default options (digits = 2, signed = false)', () => {
    it('renders a positive fraction as a two-decimal percent', () => {
      expect(formatPct(0.0125)).toBe('1.25%');
      expect(formatPct(1)).toBe('100.00%');
    });

    it('renders a negative fraction with a leading minus from toFixed', () => {
      expect(formatPct(-0.0125)).toBe('-1.25%');
    });

    it('renders zero with no sign', () => {
      expect(formatPct(0)).toBe('0.00%');
    });
  });

  describe('signed = true', () => {
    it('prepends "+" to positives only', () => {
      expect(formatPct(0.0125, { signed: true })).toBe('+1.25%');
    });

    it('does not prepend "+" to zero', () => {
      expect(formatPct(0, { signed: true })).toBe('0.00%');
    });

    it('preserves the natural minus on negatives', () => {
      expect(formatPct(-0.0125, { signed: true })).toBe('-1.25%');
    });
  });

  describe('digits parameter', () => {
    it('honors digits = 1 (Whale-flow density)', () => {
      expect(formatPct(0.0125, { digits: 1 })).toBe('1.3%');
    });

    it('combines signed + digits', () => {
      expect(formatPct(0.0125, { signed: true, digits: 1 })).toBe('+1.3%');
      expect(formatPct(-0.0125, { signed: true, digits: 1 })).toBe('-1.3%');
    });

    it('honors digits = 0', () => {
      expect(formatPct(0.123, { digits: 0 })).toBe('12%');
    });
  });

  describe('null / non-finite coalescing', () => {
    it('renders null as "—"', () => {
      expect(formatPct(null)).toBe('—');
    });

    it('renders NaN as "—"', () => {
      expect(formatPct(Number.NaN)).toBe('—');
    });

    it('renders Infinity as "—"', () => {
      expect(formatPct(Number.POSITIVE_INFINITY)).toBe('—');
      expect(formatPct(Number.NEGATIVE_INFINITY)).toBe('—');
    });
  });
});

describe('formatAskPct', () => {
  it('renders a fraction as a one-decimal percent', () => {
    expect(formatAskPct(0.5)).toBe('50.0%');
    expect(formatAskPct(0.756)).toBe('75.6%');
  });

  it('handles zero', () => {
    expect(formatAskPct(0)).toBe('0.0%');
  });

  it('handles 1.0 (full ask)', () => {
    expect(formatAskPct(1)).toBe('100.0%');
  });

  it('renders null as "—"', () => {
    expect(formatAskPct(null)).toBe('—');
  });

  it('renders NaN / Infinity as "—"', () => {
    expect(formatAskPct(Number.NaN)).toBe('—');
    expect(formatAskPct(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatGex', () => {
  describe('positive scale branches', () => {
    it('renders billions with one decimal', () => {
      expect(formatGex(2_500_000_000)).toBe('+$2.5B');
      expect(formatGex(1_000_000_000)).toBe('+$1.0B');
    });

    it('renders millions with no decimals', () => {
      expect(formatGex(120_000_000)).toBe('+$120M');
      expect(formatGex(1_000_000)).toBe('+$1M');
    });

    it('renders thousands with no decimals', () => {
      expect(formatGex(50_000)).toBe('+$50K');
      expect(formatGex(1_000)).toBe('+$1K');
    });

    it('renders sub-thousand with no decimals', () => {
      expect(formatGex(999)).toBe('+$999');
      expect(formatGex(0)).toBe('+$0');
    });
  });

  describe('negative scale branches', () => {
    it('renders negative billions', () => {
      expect(formatGex(-2_500_000_000)).toBe('-$2.5B');
    });

    it('renders negative millions', () => {
      expect(formatGex(-80_000_000)).toBe('-$80M');
    });

    it('renders negative thousands', () => {
      expect(formatGex(-50_000)).toBe('-$50K');
    });

    it('renders negative sub-thousand', () => {
      expect(formatGex(-1)).toBe('-$1');
    });
  });

  describe('boundary values at scale thresholds', () => {
    it('K → M transition at exactly 1_000_000', () => {
      expect(formatGex(999_999)).toBe('+$1000K');
      expect(formatGex(1_000_000)).toBe('+$1M');
    });

    it('M → B transition at exactly 1_000_000_000', () => {
      expect(formatGex(999_999_999)).toBe('+$1000M');
      expect(formatGex(1_000_000_000)).toBe('+$1.0B');
    });
  });

  describe('null / non-finite coalescing', () => {
    it('renders null as "—"', () => {
      expect(formatGex(null)).toBe('—');
    });

    it('renders NaN / Infinity as "—"', () => {
      expect(formatGex(Number.NaN)).toBe('—');
      expect(formatGex(Number.POSITIVE_INFINITY)).toBe('—');
      expect(formatGex(Number.NEGATIVE_INFINITY)).toBe('—');
    });
  });
});

describe('formatSignedInt', () => {
  it('prepends "+" to positives', () => {
    expect(formatSignedInt(5)).toBe('+5');
    expect(formatSignedInt(123)).toBe('+123');
  });

  it('preserves natural minus on negatives', () => {
    expect(formatSignedInt(-5)).toBe('-5');
    expect(formatSignedInt(-123)).toBe('-123');
  });

  it('renders zero as bare "0"', () => {
    expect(formatSignedInt(0)).toBe('0');
  });

  it('rounds fractional inputs', () => {
    expect(formatSignedInt(4.6)).toBe('+5');
    expect(formatSignedInt(-4.6)).toBe('-5');
    // Math.round rounds half to +Infinity, so -0.5 rounds to 0 (which we
    // surface as the bare "0" branch, not "-0").
    expect(formatSignedInt(-0.5)).toBe('0');
  });

  it('renders null as "—"', () => {
    expect(formatSignedInt(null)).toBe('—');
  });

  it('renders NaN / Infinity as "—"', () => {
    expect(formatSignedInt(Number.NaN)).toBe('—');
    expect(formatSignedInt(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatSignedInt(Number.NEGATIVE_INFINITY)).toBe('—');
  });
});
