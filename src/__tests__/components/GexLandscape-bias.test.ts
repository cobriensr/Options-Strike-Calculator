/**
 * Unit tests for GexLandscape bias synthesis (computeBias).
 * Focuses on the price-drift override that converts `rangebound` to
 * `drifting-down` / `drifting-up` when price is persistently trending.
 */

import { describe, expect, it } from 'vitest';
import {
  computeBias,
  computeNaiveSubBias,
} from '../../components/GexLandscape/bias';
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
      trend,
    );
    expect(bias.verdict).toBe('gex-pull-up');
  });

  it('preserves backward compatibility when priceTrend param is omitted', () => {
    const bias = computeBias(
      rangeboundStrikes(),
      7030,
      emptyDeltaMap,
      emptyDeltaMap,
    );
    expect(bias.verdict).toBe('rangebound');
    expect(bias.priceTrend).toBeNull();
  });

  it('passes naive sub-bias straight through to BiasMetrics.naive', () => {
    const naive = {
      gravityStrike: 7050,
      gravityOffset: 20,
      gravityGex: 1_000_000,
      upsideTargets: [],
      downsideTargets: [],
      floorTrend10m: null,
      ceilingTrend10m: null,
      floorTrend30m: null,
      ceilingTrend30m: null,
    };
    const bias = computeBias(
      rangeboundStrikes(),
      7030,
      emptyDeltaMap,
      emptyDeltaMap,
      null,
      naive,
    );
    expect(bias.naive).toBe(naive);
  });

  it('defaults naive to null when omitted', () => {
    const bias = computeBias(
      rangeboundStrikes(),
      7030,
      emptyDeltaMap,
      emptyDeltaMap,
    );
    expect(bias.naive).toBeNull();
  });
});

describe('computeNaiveSubBias', () => {
  it('returns null when every strike has zero naive OI (no WS data)', () => {
    const strikes = [
      makeStrike({ strike: 7060, callGammaOi: 0, putGammaOi: 0 }),
      makeStrike({ strike: 7030, callGammaOi: 0, putGammaOi: 0 }),
    ];
    expect(
      computeNaiveSubBias(strikes, 7030, emptyDeltaMap, emptyDeltaMap),
    ).toBeNull();
  });

  it('picks the gravity strike by largest |callGammaOi + putGammaOi|', () => {
    const strikes = [
      // 7060 above spot: naive = +5 + 3 = 8 (smaller absolute)
      makeStrike({ strike: 7060, callGammaOi: 5, putGammaOi: 3 }),
      // 7000 below spot: naive = 1 + (-30) = -29 (largest absolute → gravity)
      makeStrike({ strike: 7000, callGammaOi: 1, putGammaOi: -30 }),
      // 7050 above spot: naive = 4 + 1 = 5
      makeStrike({ strike: 7050, callGammaOi: 4, putGammaOi: 1 }),
    ];
    const naive = computeNaiveSubBias(
      strikes,
      7030,
      emptyDeltaMap,
      emptyDeltaMap,
    );
    expect(naive).not.toBeNull();
    expect(naive?.gravityStrike).toBe(7000);
    expect(naive?.gravityGex).toBe(-29);
    expect(naive?.gravityOffset).toBe(-30);
  });

  it('builds top-2 drift targets above and below spot by |naive netGamma|', () => {
    // Use widely-separated strikes so the SPX_SPOT_BAND filter doesn't
    // strip out near-ATM rows from the above/below buckets.
    const strikes = [
      makeStrike({ strike: 7080, callGammaOi: 100, putGammaOi: 0 }), // |100| upside #1
      makeStrike({ strike: 7070, callGammaOi: 50, putGammaOi: 0 }), //  |50| upside #2
      makeStrike({ strike: 7060, callGammaOi: 10, putGammaOi: 0 }), //  |10| upside #3 — dropped
      makeStrike({ strike: 7000, callGammaOi: 0, putGammaOi: -90 }), //  |90| downside #1
      makeStrike({ strike: 6990, callGammaOi: 0, putGammaOi: -40 }), //  |40| downside #2
    ];
    const naive = computeNaiveSubBias(
      strikes,
      7030,
      emptyDeltaMap,
      emptyDeltaMap,
    );
    expect(naive?.upsideTargets.map((t) => t.strike)).toEqual([7080, 7070]);
    expect(naive?.downsideTargets.map((t) => t.strike)).toEqual([7000, 6990]);
  });

  it('averages naive Δ% across strikes above (ceiling) and below (floor) spot', () => {
    const strikes = [
      // Above spot
      makeStrike({ strike: 7080, callGammaOi: 10, putGammaOi: 0 }),
      makeStrike({ strike: 7070, callGammaOi: 5, putGammaOi: 0 }),
      // Below spot
      makeStrike({ strike: 7000, callGammaOi: 0, putGammaOi: -10 }),
    ];
    const naiveDelta10m = new Map<number, number | null>([
      [7080, 10],
      [7070, 6],
      [7000, -8],
    ]);
    const naive = computeNaiveSubBias(
      strikes,
      7030,
      naiveDelta10m,
      emptyDeltaMap,
    );
    // (10 + 6) / 2 = 8
    expect(naive?.ceilingTrend10m).toBe(8);
    // single value below spot
    expect(naive?.floorTrend10m).toBe(-8);
    // No 30m map values supplied
    expect(naive?.floorTrend30m).toBeNull();
    expect(naive?.ceilingTrend30m).toBeNull();
  });
});
