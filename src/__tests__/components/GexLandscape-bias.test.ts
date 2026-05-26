/**
 * Unit tests for GexLandscape bias synthesis (computeBias).
 *
 * Phase 3 of the 1-min GexBot rebuild
 * (docs/superpowers/specs/gex-landscape-1min-gexbot-rebuild-2026-05-26.md):
 *   - computeBias now takes 3 delta maps (1m/5m/10m) and returns 6 trend fields
 *   - the legacy naive sub-bias (computeNaiveSubBias) is gone
 *   - the verdict + gravity + price-drift override logic is unchanged
 */

import { describe, expect, it } from 'vitest';
import { computeBias } from '../../components/GexLandscape/bias';
import type {
  GexStrikeLevel,
  PriceTrend,
} from '../../components/GexLandscape/types';

/** Create a strike with sensible defaults for bias testing. */
function makeStrike(overrides: Partial<GexStrikeLevel> = {}): GexStrikeLevel {
  return {
    strike: 7030,
    price: 7030,
    callGammaOi: 5e11,
    putGammaOi: -3e11,
    netGamma: 2e9, // positive → contributes to positive regime
    callGammaVol: 1e11,
    putGammaVol: -5e10,
    netGammaVol: 5e10,
    volReinforcement: 'neutral',
    callGammaAsk: -1e8,
    callGammaBid: 2e8,
    putGammaAsk: 5e7,
    putGammaBid: -1.5e8,
    callCharmOi: 1e9,
    putCharmOi: -8e8,
    netCharm: 2e8,
    callCharmVol: 5e8,
    putCharmVol: -4e8,
    netCharmVol: 1e8,
    callDeltaOi: 5e9,
    putDeltaOi: -3e9,
    netDelta: 2e9,
    callVannaOi: 1e8,
    putVannaOi: -6e7,
    netVanna: 4e7,
    callVannaVol: 5e7,
    putVannaVol: -3e7,
    netVannaVol: 2e7,
    ...overrides,
  };
}

/**
 * Build a set of strikes that produces a `rangebound` base verdict:
 * - Positive total GEX (gravity strike near ATM with large positive gamma)
 * - Gravity within the per-ticker spot band (25 pts for SPX default) of spot
 */
function rangeboundStrikes(): GexStrikeLevel[] {
  return [
    // ATM gravity — largest |netGamma|, within 25 pts of spot (SPX default band)
    makeStrike({ strike: 7030, netGamma: 8e9 }),
    // Some above and below strikes with smaller gamma
    makeStrike({ strike: 7050, netGamma: 1e9 }),
    makeStrike({ strike: 7045, netGamma: 5e8 }),
    makeStrike({ strike: 7010, netGamma: 1e9 }),
    makeStrike({ strike: 7015, netGamma: 5e8 }),
  ];
}

const emptyDeltaMap = new Map<number, number | null>();

describe('computeBias drift override', () => {
  it('overrides rangebound to drifting-down when price trend is down', () => {
    const trend: PriceTrend = {
      direction: 'down',
      changePct: -0.1,
      changePts: -7,
      consistency: 0.8,
    };
    const bias = computeBias(
      rangeboundStrikes(),
      7030,
      emptyDeltaMap,
      emptyDeltaMap,
      emptyDeltaMap,
      trend,
    );
    expect(bias.verdict).toBe('drifting-down');
    expect(bias.priceTrend).toBe(trend);
  });

  it('overrides rangebound to drifting-up when price trend is up', () => {
    const trend: PriceTrend = {
      direction: 'up',
      changePct: 0.08,
      changePts: 5.5,
      consistency: 0.7,
    };
    const bias = computeBias(
      rangeboundStrikes(),
      7030,
      emptyDeltaMap,
      emptyDeltaMap,
      emptyDeltaMap,
      trend,
    );
    expect(bias.verdict).toBe('drifting-up');
  });

  it('keeps rangebound when price trend is flat', () => {
    const trend: PriceTrend = {
      direction: 'flat',
      changePct: 0,
      changePts: 0,
      consistency: 0,
    };
    const bias = computeBias(
      rangeboundStrikes(),
      7030,
      emptyDeltaMap,
      emptyDeltaMap,
      emptyDeltaMap,
      trend,
    );
    expect(bias.verdict).toBe('rangebound');
  });

  it('keeps rangebound when priceTrend is null (no data yet)', () => {
    const bias = computeBias(
      rangeboundStrikes(),
      7030,
      emptyDeltaMap,
      emptyDeltaMap,
      emptyDeltaMap,
      null,
    );
    expect(bias.verdict).toBe('rangebound');
  });

  it('does NOT override non-rangebound verdicts even with a drifting price', () => {
    // Build strikes that produce gex-pull-up: gravity above spot, positive regime
    const strikes = [
      makeStrike({ strike: 7030, netGamma: 1e9 }),
      makeStrike({ strike: 7060, netGamma: 10e9 }), // largest, >25pts above spot (SPX default band)
      makeStrike({ strike: 7010, netGamma: 5e8 }),
    ];
    const trend: PriceTrend = {
      direction: 'up',
      changePct: 0.2,
      changePts: 14,
      consistency: 0.9,
    };
    const bias = computeBias(
      strikes,
      7030,
      emptyDeltaMap,
      emptyDeltaMap,
      emptyDeltaMap,
      trend,
    );
    expect(bias.verdict).toBe('gex-pull-up');
  });

  it('defaults priceTrend to null when the param is omitted', () => {
    const bias = computeBias(
      rangeboundStrikes(),
      7030,
      emptyDeltaMap,
      emptyDeltaMap,
      emptyDeltaMap,
    );
    expect(bias.verdict).toBe('rangebound');
    expect(bias.priceTrend).toBeNull();
  });
});

describe('computeBias trend fields', () => {
  it('returns 6 trend fields (floor + ceiling × 1m/5m/10m) populated from the 3 delta maps', () => {
    const strikes = [
      // Above spot — feed ceiling trends
      makeStrike({ strike: 7080, netGamma: 1e9 }),
      makeStrike({ strike: 7070, netGamma: 1e9 }),
      // Below spot — feed floor trends
      makeStrike({ strike: 7000, netGamma: 1e9 }),
      makeStrike({ strike: 6990, netGamma: 1e9 }),
    ];
    const delta1m = new Map<number, number | null>([
      [7080, 4],
      [7070, 2],
      [7000, -1],
      [6990, -3],
    ]);
    const delta5m = new Map<number, number | null>([
      [7080, 8],
      [7070, 6],
      [7000, -4],
      [6990, -6],
    ]);
    const delta10m = new Map<number, number | null>([
      [7080, 10],
      [7070, 6],
      [7000, -8],
      [6990, -12],
    ]);
    const bias = computeBias(strikes, 7030, delta1m, delta5m, delta10m);
    // ceiling = mean above spot, floor = mean below spot
    expect(bias.ceilingTrend1m).toBe(3); // (4 + 2) / 2
    expect(bias.floorTrend1m).toBe(-2); // (-1 + -3) / 2
    expect(bias.ceilingTrend5m).toBe(7); // (8 + 6) / 2
    expect(bias.floorTrend5m).toBe(-5); // (-4 + -6) / 2
    expect(bias.ceilingTrend10m).toBe(8); // (10 + 6) / 2
    expect(bias.floorTrend10m).toBe(-10); // (-8 + -12) / 2
  });

  it('returns null for trend fields when the corresponding delta map has no usable values', () => {
    const bias = computeBias(
      rangeboundStrikes(),
      7030,
      emptyDeltaMap,
      emptyDeltaMap,
      emptyDeltaMap,
    );
    expect(bias.floorTrend1m).toBeNull();
    expect(bias.ceilingTrend1m).toBeNull();
    expect(bias.floorTrend5m).toBeNull();
    expect(bias.ceilingTrend5m).toBeNull();
    expect(bias.floorTrend10m).toBeNull();
    expect(bias.ceilingTrend10m).toBeNull();
  });
});
