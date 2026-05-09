// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { avgHoldMinutesFor } from '../_lib/lottery-hold';

describe('avgHoldMinutesFor (lottery)', () => {
  describe('tier defaults (no per-ticker override)', () => {
    it.each<['tier1' | 'tier2' | 'tier3', number]>([
      ['tier1', 219],
      ['tier2', 160],
      ['tier3', 230],
    ])('returns tier-default for tier %s on AAPL', (tier, expected) => {
      expect(avgHoldMinutesFor({ tier, ticker: 'AAPL' })).toBe(expected);
    });
  });

  describe('per-ticker overrides — tier1', () => {
    it('RKLB tier1 → 343 (longer than tier1 default of 219)', () => {
      expect(avgHoldMinutesFor({ tier: 'tier1', ticker: 'RKLB' })).toBe(343);
    });

    it('SLV tier1 → 102 (much shorter than tier1 default)', () => {
      expect(avgHoldMinutesFor({ tier: 'tier1', ticker: 'SLV' })).toBe(102);
    });
  });

  describe('per-ticker overrides — tier2', () => {
    it('QQQ tier2 → 42 (shortest tier2 override)', () => {
      expect(avgHoldMinutesFor({ tier: 'tier2', ticker: 'QQQ' })).toBe(42);
    });

    it('WMT tier2 → 296 (longest tier2 override)', () => {
      expect(avgHoldMinutesFor({ tier: 'tier2', ticker: 'WMT' })).toBe(296);
    });
  });

  describe('per-ticker overrides — tier3', () => {
    it('SPXW tier3 → 50 (the most extreme tier3 override)', () => {
      expect(avgHoldMinutesFor({ tier: 'tier3', ticker: 'SPXW' })).toBe(50);
    });

    it('QQQ tier3 → 104 (different from QQQ tier2 override of 42)', () => {
      expect(avgHoldMinutesFor({ tier: 'tier3', ticker: 'QQQ' })).toBe(104);
    });
  });

  describe('tier mismatch falls through to tier default', () => {
    it('RKLB tier3 → 230 (no override at tier3, uses tier3 default)', () => {
      expect(avgHoldMinutesFor({ tier: 'tier3', ticker: 'RKLB' })).toBe(230);
    });

    it('SLV tier2 → 160 (no override at tier2, uses tier2 default)', () => {
      expect(avgHoldMinutesFor({ tier: 'tier2', ticker: 'SLV' })).toBe(160);
    });
  });

  describe('null tier fallback', () => {
    it('null tier → tier3 default (230) on a non-override ticker', () => {
      expect(avgHoldMinutesFor({ tier: null, ticker: 'AAPL' })).toBe(230);
    });

    it('null tier on QQQ → uses QQQ tier3 override (104)', () => {
      expect(avgHoldMinutesFor({ tier: null, ticker: 'QQQ' })).toBe(104);
    });
  });

  describe('ticker case insensitivity', () => {
    it('lowercase rklb → resolves to RKLB tier1 override', () => {
      expect(avgHoldMinutesFor({ tier: 'tier1', ticker: 'rklb' })).toBe(343);
    });

    it('mixed-case Spxw → resolves to SPXW tier3 override', () => {
      expect(avgHoldMinutesFor({ tier: 'tier3', ticker: 'Spxw' })).toBe(50);
    });
  });

  describe('unknown ticker', () => {
    it('returns tier default for ticker not in override map', () => {
      expect(
        avgHoldMinutesFor({ tier: 'tier1', ticker: 'NEVER_HEARD_OF' }),
      ).toBe(219);
    });
  });
});
