/**
 * Unit tests for GexLandscape bias synthesis (computeBias).
 * Focuses on the price-drift override that converts `rangebound` to
 * `drifting-down` / `drifting-up` when price is persistently trending.
 */

import { describe, expect, it } from 'vitest';
import { computeBias } from '../../components/GexLandscape/bias';
import type { GexStrikeLevel } from '../../hooks/useGexPerStrike';
import type { PriceTrend } from '../../components/GexLandscape/types';

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
 * - Gravity within SPOT_BAND (12 pts) of spot
 */
function rangeboundStrikes(): GexStrikeLevel[] {
  return [
    // ATM gravity — largest |netGamma|, within 12 pts of spot (7030)
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
      makeStrike({ strike: 7060, netGamma: 10e9 }), // largest, >12pts above spot
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
});
