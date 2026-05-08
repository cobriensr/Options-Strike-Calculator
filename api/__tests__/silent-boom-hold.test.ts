// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { avgHoldMinutesFor } from '../_lib/silent-boom-hold';

describe('avgHoldMinutesFor', () => {
  describe('tier defaults (no per-ticker override)', () => {
    it.each<['tier1' | 'tier2' | 'tier3', number]>([
      ['tier1', 144],
      ['tier2', 197],
      ['tier3', 224],
    ])('returns tier-default for tier %s on AAPL', (tier, expected) => {
      expect(avgHoldMinutesFor({ tier, ticker: 'AAPL' })).toBe(expected);
    });
  });

  describe('per-ticker overrides', () => {
    it('QQQ tier1 → 89 (overrides tier1 default of 144)', () => {
      expect(avgHoldMinutesFor({ tier: 'tier1', ticker: 'QQQ' })).toBe(89);
    });

    it('QQQ tier2 → 197 (no override at tier2; falls to tier default)', () => {
      expect(avgHoldMinutesFor({ tier: 'tier2', ticker: 'QQQ' })).toBe(197);
    });

    it('SPXW tier3 → 296 (overrides tier3 default of 224)', () => {
      expect(avgHoldMinutesFor({ tier: 'tier3', ticker: 'SPXW' })).toBe(296);
    });

    it('SPXW tier1 → 144 (no override at tier1; falls to tier default)', () => {
      expect(avgHoldMinutesFor({ tier: 'tier1', ticker: 'SPXW' })).toBe(144);
    });
  });

  describe('null tier fallback', () => {
    it('null tier → tier3 default (224) on a non-override ticker', () => {
      expect(avgHoldMinutesFor({ tier: null, ticker: 'AAPL' })).toBe(224);
    });

    it('null tier on SPXW → uses SPXW tier3 override (296)', () => {
      expect(avgHoldMinutesFor({ tier: null, ticker: 'SPXW' })).toBe(296);
    });
  });

  describe('ticker case insensitivity', () => {
    it('lowercase qqq → resolves to QQQ tier1 override', () => {
      expect(avgHoldMinutesFor({ tier: 'tier1', ticker: 'qqq' })).toBe(89);
    });

    it('mixed-case Spxw → resolves to SPXW tier3 override', () => {
      expect(avgHoldMinutesFor({ tier: 'tier3', ticker: 'Spxw' })).toBe(296);
    });
  });

  describe('unknown ticker', () => {
    it('returns tier default for ticker not in override map', () => {
      expect(
        avgHoldMinutesFor({ tier: 'tier2', ticker: 'NEVER_HEARD_OF' }),
      ).toBe(197);
    });
  });
});
