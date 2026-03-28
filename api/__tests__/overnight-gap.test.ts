// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { formatOvernightForClaude } from '../_lib/overnight-gap.js';
import type { PreMarketData } from '../pre-market.js';

/** Base pre-market data with all required fields */
function basePreMarket(overrides: Partial<PreMarketData> = {}): PreMarketData {
  return {
    globexHigh: 5720,
    globexLow: 5690,
    globexClose: 5710,
    globexVwap: 5705,
    straddleConeUpper: 5760,
    straddleConeLower: 5660,
    savedAt: '2026-03-28T12:00:00Z',
    ...overrides,
  };
}

describe('formatOvernightForClaude', () => {
  // ── Null guards ───────────────────────────────────────────

  it('returns null when globexHigh is null', () => {
    const result = formatOvernightForClaude({
      preMarket: basePreMarket({ globexHigh: null }),
      cashOpen: 5715,
      prevClose: 5700,
    });
    expect(result).toBeNull();
  });

  it('returns null when globexLow is null', () => {
    const result = formatOvernightForClaude({
      preMarket: basePreMarket({ globexLow: null }),
      cashOpen: 5715,
      prevClose: 5700,
    });
    expect(result).toBeNull();
  });

  it('returns null when globexClose is null', () => {
    const result = formatOvernightForClaude({
      preMarket: basePreMarket({ globexClose: null }),
      cashOpen: 5715,
      prevClose: 5700,
    });
    expect(result).toBeNull();
  });

  // ── Session summary ───────────────────────────────────────

  it('includes session summary with high, low, close, range', () => {
    const result = formatOvernightForClaude({
      preMarket: basePreMarket(),
      cashOpen: 5715,
      prevClose: 5700,
    })!;

    expect(result).toContain('ES Overnight Session');
    expect(result).toContain('High: 5720.00');
    expect(result).toContain('Low: 5690.00');
    expect(result).toContain('Close: 5710.00');
    expect(result).toContain('Range: 30.0 pts');
  });

  it('includes VWAP when provided', () => {
    const result = formatOvernightForClaude({
      preMarket: basePreMarket({ globexVwap: 5705 }),
      cashOpen: 5715,
      prevClose: 5700,
    })!;

    expect(result).toContain('VWAP: 5705.00');
  });

  it('omits VWAP when null', () => {
    const result = formatOvernightForClaude({
      preMarket: basePreMarket({ globexVwap: null }),
      cashOpen: 5715,
      prevClose: 5700,
    })!;

    expect(result).not.toContain('VWAP:');
  });

  // ── Cone context ──────────────────────────────────────────

  it('shows cone consumption percentage', () => {
    // cone width = 100 pts, overnight range = 30 pts → 30%
    const result = formatOvernightForClaude({
      preMarket: basePreMarket({
        straddleConeUpper: 5760,
        straddleConeLower: 5660,
      }),
      cashOpen: 5715,
      prevClose: 5700,
    })!;

    expect(result).toContain('30% of straddle cone');
  });

  it('warns when >60% of cone consumed', () => {
    // cone width = 40 pts, overnight range = 30 pts → 75%
    const result = formatOvernightForClaude({
      preMarket: basePreMarket({
        straddleConeUpper: 5730,
        straddleConeLower: 5690,
      }),
      cashOpen: 5715,
      prevClose: 5700,
    })!;

    expect(result).toContain('>60% of expected move happened overnight');
  });

  it('notes quiet overnight when <20% consumed', () => {
    // cone width = 200 pts, overnight range = 30 pts → 15%
    const result = formatOvernightForClaude({
      preMarket: basePreMarket({
        straddleConeUpper: 5800,
        straddleConeLower: 5600,
      }),
      cashOpen: 5715,
      prevClose: 5700,
    })!;

    expect(result).toContain('Quiet overnight');
  });

  it('omits cone lines when cone bounds are null', () => {
    const result = formatOvernightForClaude({
      preMarket: basePreMarket({
        straddleConeUpper: null,
        straddleConeLower: null,
      }),
      cashOpen: 5715,
      prevClose: 5700,
    })!;

    expect(result).not.toContain('straddle cone');
  });

  it('skips cone consumption when coneWidth is 0', () => {
    const result = formatOvernightForClaude({
      preMarket: basePreMarket({
        straddleConeUpper: 5700,
        straddleConeLower: 5700,
      }),
      cashOpen: 5715,
      prevClose: 5700,
    })!;

    // Zero-width cone skips the consumption line but implications still reference it
    expect(result).not.toContain('Quiet overnight');
    expect(result).not.toContain('>60% of expected move');
  });

  // ── Gap analysis ──────────────────────────────────────────

  it('classifies gap UP with correct size', () => {
    const result = formatOvernightForClaude({
      preMarket: basePreMarket(),
      cashOpen: 5720,
      prevClose: 5700,
    })!;

    expect(result).toContain('Gap: UP 20.0 pts');
    expect(result).toContain('Gap Size: MODERATE');
  });

  it('classifies gap DOWN', () => {
    const result = formatOvernightForClaude({
      preMarket: basePreMarket(),
      cashOpen: 5680,
      prevClose: 5700,
    })!;

    expect(result).toContain('Gap: DOWN 20.0 pts');
  });

  it('classifies FLAT gap', () => {
    const result = formatOvernightForClaude({
      preMarket: basePreMarket(),
      cashOpen: 5700,
      prevClose: 5700,
    })!;

    expect(result).toContain('Gap: FLAT');
    expect(result).toContain('Gap Size: NEGLIGIBLE');
  });

  it('classifies NEGLIGIBLE gap (<5 pts)', () => {
    const result = formatOvernightForClaude({
      preMarket: basePreMarket(),
      cashOpen: 5703,
      prevClose: 5700,
    })!;

    expect(result).toContain('Gap Size: NEGLIGIBLE');
  });

  it('classifies SMALL gap (5-15 pts)', () => {
    const result = formatOvernightForClaude({
      preMarket: basePreMarket(),
      cashOpen: 5710,
      prevClose: 5700,
    })!;

    expect(result).toContain('Gap Size: SMALL');
  });

  it('classifies LARGE gap (30-50 pts)', () => {
    const result = formatOvernightForClaude({
      preMarket: basePreMarket(),
      cashOpen: 5740,
      prevClose: 5700,
    })!;

    expect(result).toContain('Gap Size: LARGE');
  });

  it('classifies EXTREME gap (>50 pts)', () => {
    const result = formatOvernightForClaude({
      preMarket: basePreMarket(),
      cashOpen: 5760,
      prevClose: 5700,
    })!;

    expect(result).toContain('Gap Size: EXTREME');
  });

  // ── Open position vs overnight range ──────────────────────

  it('labels AT GLOBEX HIGH when pctRank > 90', () => {
    // cashOpen near globexHigh: (5719-5690)/(30) = 96.7th percentile
    const result = formatOvernightForClaude({
      preMarket: basePreMarket(),
      cashOpen: 5719,
      prevClose: 5700,
    })!;

    expect(result).toContain('AT GLOBEX HIGH');
  });

  it('labels NEAR HIGH when pctRank 70-90', () => {
    // (5714-5690)/30 = 80th percentile
    const result = formatOvernightForClaude({
      preMarket: basePreMarket(),
      cashOpen: 5714,
      prevClose: 5700,
    })!;

    expect(result).toContain('NEAR HIGH');
  });

  it('labels MID-RANGE when pctRank 30-70', () => {
    // (5705-5690)/30 = 50th percentile
    const result = formatOvernightForClaude({
      preMarket: basePreMarket(),
      cashOpen: 5705,
      prevClose: 5700,
    })!;

    expect(result).toContain('MID-RANGE');
  });

  it('labels NEAR LOW when pctRank 10-30', () => {
    // (5696-5690)/30 = 20th percentile
    const result = formatOvernightForClaude({
      preMarket: basePreMarket(),
      cashOpen: 5696,
      prevClose: 5700,
    })!;

    expect(result).toContain('NEAR LOW');
  });

  it('labels AT GLOBEX LOW when pctRank < 10', () => {
    // (5691-5690)/30 = 3.3rd percentile
    const result = formatOvernightForClaude({
      preMarket: basePreMarket(),
      cashOpen: 5691,
      prevClose: 5700,
    })!;

    expect(result).toContain('AT GLOBEX LOW');
  });

  // ── VWAP interpretation ───────────────────────────────────

  it('interprets gap UP with open above VWAP as supported', () => {
    // gap UP (cashOpen > prevClose) + open above VWAP
    const result = formatOvernightForClaude({
      preMarket: basePreMarket({ globexVwap: 5700 }),
      cashOpen: 5715,
      prevClose: 5700,
    })!;

    expect(result).toContain('institutional support');
  });

  it('interprets gap UP with open below VWAP as overshoot', () => {
    // gap UP but open below VWAP
    const result = formatOvernightForClaude({
      preMarket: basePreMarket({ globexVwap: 5720 }),
      cashOpen: 5715,
      prevClose: 5700,
    })!;

    expect(result).toContain('overshoot');
    expect(result).toContain('likely to fade');
  });

  it('interprets gap DOWN with open below VWAP as extending', () => {
    // gap DOWN (cashOpen < prevClose) + open below VWAP
    const result = formatOvernightForClaude({
      preMarket: basePreMarket({ globexVwap: 5700 }),
      cashOpen: 5685,
      prevClose: 5700,
    })!;

    expect(result).toContain('likely to extend');
  });

  it('interprets gap DOWN with open above VWAP as filling', () => {
    // gap DOWN but open above VWAP
    const result = formatOvernightForClaude({
      preMarket: basePreMarket({ globexVwap: 5680 }),
      cashOpen: 5685,
      prevClose: 5700,
    })!;

    expect(result).toContain('likely to fill');
  });

  it('interprets flat gap', () => {
    const result = formatOvernightForClaude({
      preMarket: basePreMarket({ globexVwap: 5700 }),
      cashOpen: 5700,
      prevClose: 5700,
    })!;

    expect(result).toContain('Flat gap');
  });

  it('omits VWAP interpretation when VWAP is null', () => {
    const result = formatOvernightForClaude({
      preMarket: basePreMarket({ globexVwap: null }),
      cashOpen: 5715,
      prevClose: 5700,
    })!;

    expect(result).not.toContain('Open vs VWAP');
  });

  // ── Gap fill probability ──────────────────────────────────

  it('computes HIGH fill probability for small gap + extreme position + overshoot', () => {
    // Small gap (+5 pts): +30 score
    // At globex low (~3rd pctile): +20 score
    // Gap UP, open below VWAP (overshoot): +20 score
    // Total: 30 + 20 + 20 = 70 → HIGH
    const result = formatOvernightForClaude({
      preMarket: basePreMarket({ globexVwap: 5720 }),
      cashOpen: 5691,
      prevClose: 5686,
    })!;

    expect(result).toContain('Gap Fill Probability: HIGH');
  });

  it('computes LOW fill probability for large gap + supported', () => {
    // Large gap (+45 pts): -20 score
    // Mid-range position: -10 score
    // Gap UP + above VWAP: -15 score
    // Total: -20 + -10 + -15 = -45 → LOW
    const result = formatOvernightForClaude({
      preMarket: basePreMarket({ globexVwap: 5700 }),
      cashOpen: 5745,
      prevClose: 5700,
    })!;

    expect(result).toContain('Gap Fill Probability: LOW');
  });

  it('computes MODERATE fill probability for mid-size gap', () => {
    // Gap 15-20: +15 score
    // Near high (~80th pctile): +5 score
    // No VWAP: 0
    // Total: 15 + 5 = 20 → MODERATE
    const result = formatOvernightForClaude({
      preMarket: basePreMarket({ globexVwap: null }),
      cashOpen: 5715,
      prevClose: 5700,
    })!;

    expect(result).toContain('Gap Fill Probability: MODERATE');
  });

  // ── 0DTE implications ─────────────────────────────────────

  it('includes remaining cone percentage in implications', () => {
    const result = formatOvernightForClaude({
      preMarket: basePreMarket(),
      cashOpen: 5715,
      prevClose: 5700,
    })!;

    expect(result).toContain('Implication for 0DTE');
    expect(result).toContain('% of straddle cone remaining');
  });

  it('includes gap direction implication for UP gap with HIGH fill', () => {
    // Same inputs as HIGH fill test above
    const result = formatOvernightForClaude({
      preMarket: basePreMarket({ globexVwap: 5720 }),
      cashOpen: 5691,
      prevClose: 5686,
    })!;

    expect(result).toContain('likely to fill');
  });

  it('includes gap direction implication for gap with LOW fill', () => {
    const result = formatOvernightForClaude({
      preMarket: basePreMarket({ globexVwap: 5700 }),
      cashOpen: 5745,
      prevClose: 5700,
    })!;

    expect(result).toContain('likely to extend');
  });

  it('omits gap direction line for FLAT gap', () => {
    const result = formatOvernightForClaude({
      preMarket: basePreMarket(),
      cashOpen: 5700,
      prevClose: 5700,
    })!;

    expect(result).toContain('Implication for 0DTE');
    // FLAT gap should not include gap direction implication
    expect(result).not.toContain('Gap direction (FLAT)');
  });

  it('omits cone remaining when no cone bounds', () => {
    const result = formatOvernightForClaude({
      preMarket: basePreMarket({
        straddleConeUpper: null,
        straddleConeLower: null,
      }),
      cashOpen: 5715,
      prevClose: 5700,
    })!;

    expect(result).not.toContain('% of straddle cone remaining');
  });
});
