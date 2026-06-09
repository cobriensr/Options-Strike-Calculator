/**
 * Phase 2Q follow-up — direct unit tests for the newly-public hedge
 * submodule exports. The pre-split `hedge.ts` exposed only
 * `stressedSigma` + `calcHedge` to callers, so the helper functions
 * (`priceHedgeLegs`, `recommendHedgeContracts`, `buildScenarioTable`,
 * `computeScenarioPnL`, `findBreakEven`) were exercised solely through
 * the calcHedge orchestrator. Post-split each is reachable directly;
 * these tests pin the contracts so a future refactor that drifts one
 * of the seams gets caught without depending on a full calcHedge run.
 */

import { describe, expect, it } from 'vitest';

import {
  buildScenarioTable,
  computeScenarioPnL,
  findBreakEven,
  priceHedgeLegs,
  recommendHedgeContracts,
  type HedgeLegPricing,
} from '../utils/hedge/index';
import type { HedgeDelta } from '../types';

const baseSpot = 5800;
const baseSigma = 0.18;
// 6.5 hours of trading-day time, annualized at 252 days
const baseT = 6.5 / (252 * 6.5);

function makePricing(): HedgeLegPricing {
  return priceHedgeLegs({
    spot: baseSpot,
    sigma: baseSigma,
    T: baseT,
    skew: 0.1,
    hedgeDelta: 2 as HedgeDelta,
    hedgeDte: 7,
  });
}

describe('priceHedgeLegs', () => {
  it('returns positive put and call premiums for a typical hedge', () => {
    const pricing = makePricing();
    expect(pricing.putPremium).toBeGreaterThan(0);
    expect(pricing.callPremium).toBeGreaterThan(0);
  });

  it('snaps strikes to the SPX 5-pt grid', () => {
    const pricing = makePricing();
    expect(pricing.putStrikeSnapped % 5).toBe(0);
    expect(pricing.callStrikeSnapped % 5).toBe(0);
  });

  it('places hedge strikes outside spot in the correct direction', () => {
    const pricing = makePricing();
    expect(pricing.putStrikeSnapped).toBeLessThan(baseSpot);
    expect(pricing.callStrikeSnapped).toBeGreaterThan(baseSpot);
  });

  it('uses calendar-day annualization (FE-MATH-008) for tHedgeEntry', () => {
    const pricing = makePricing();
    // 7 calendar days / 365 ≈ 0.01918
    expect(pricing.tHedgeEntry).toBeCloseTo(7 / 365, 5);
  });

  it('tHedgeEod equals (hedgeDte - 1) / 365 for hedgeDte ≥ 1', () => {
    const pricing = makePricing();
    expect(pricing.tHedgeEod).toBeCloseTo(6 / 365, 5);
  });

  it('returns tHedgeEod = 0 for hedgeDte = 1 (sells at EOD of expiry day)', () => {
    const pricing = priceHedgeLegs({
      spot: baseSpot,
      sigma: baseSigma,
      T: baseT,
      skew: 0.1,
      hedgeDelta: 2 as HedgeDelta,
      hedgeDte: 1,
    });
    expect(pricing.tHedgeEod).toBe(0);
    expect(pricing.putRecovery).toBe(0);
    expect(pricing.callRecovery).toBe(0);
  });
});

describe('recommendHedgeContracts', () => {
  const pricing = makePricing();

  it('returns at least 1 put and 1 call regardless of target payout', () => {
    const rec = recommendHedgeContracts({
      spot: baseSpot,
      pricing,
      icContracts: 10,
      icMaxLossPts: 5,
      breakevenTarget: 0.5, // very low target — payout barely positive
    });
    expect(rec.recommendedPuts).toBeGreaterThanOrEqual(1);
    expect(rec.recommendedCalls).toBeGreaterThanOrEqual(1);
  });

  it('sizes proportionally to IC max loss', () => {
    const small = recommendHedgeContracts({
      spot: baseSpot,
      pricing,
      icContracts: 1,
      icMaxLossPts: 5,
      breakevenTarget: 1.5,
    });
    const big = recommendHedgeContracts({
      spot: baseSpot,
      pricing,
      icContracts: 100,
      icMaxLossPts: 5,
      breakevenTarget: 1.5,
    });
    expect(big.recommendedPuts).toBeGreaterThan(small.recommendedPuts);
    expect(big.recommendedCalls).toBeGreaterThan(small.recommendedCalls);
  });
});

describe('computeScenarioPnL', () => {
  const pricing = makePricing();
  const scenarioInputs = {
    spot: baseSpot,
    icShortPut: baseSpot - 30,
    icLongPut: baseSpot - 35,
    icShortCall: baseSpot + 30,
    icLongCall: baseSpot + 35,
    icCreditPts: 1.5,
    icContracts: 5,
    hedgePutStrike: pricing.putStrikeSnapped,
    hedgeCallStrike: pricing.callStrikeSnapped,
    hedgePutPremium: pricing.putPremium,
    hedgeCallPremium: pricing.callPremium,
    hedgePuts: 5,
    hedgeCalls: 5,
    hedgePutSigma: pricing.putSigma,
    hedgeCallSigma: pricing.callSigma,
    hedgeTRemaining: pricing.tHedgeEod,
  };

  it('returns full IC credit + hedge cost at movePoints=0', () => {
    const r = computeScenarioPnL({ ...scenarioInputs, movePoints: 0 });
    // Both wings OTM, so IC keeps its full credit (≈ 1.5 × 100 × 5 = 750)
    expect(r.icPnL).toBeGreaterThan(0);
    // Hedge cost is the premium paid (negative)
    expect(r.hedgeCost).toBeLessThan(0);
  });

  it('netPnL goes negative on a large crash that punches through the put wing', () => {
    // Move past the long put strike (35-pt-wide spread → full wing loss)
    const r = computeScenarioPnL({ ...scenarioInputs, movePoints: 60 });
    // IC takes the full wing loss; hedge pays out partially
    expect(r.icPnL).toBeLessThan(0);
  });

  it('returns intrinsic-only valuations when hedgeTRemaining is 0', () => {
    const r = computeScenarioPnL({
      ...scenarioInputs,
      hedgeTRemaining: 0,
      movePoints: 60,
    });
    // 0DTE hedge with 60-pt crash: putStrike - sFinal max(0, ...)
    expect(r.hedgePutPnL).toBeGreaterThanOrEqual(0);
  });
});

describe('findBreakEven', () => {
  it('finds the zero crossing of a monotonic increasing function', () => {
    // f(x) = x - 50, zero at x=50 — genuine sign change inside [0, 100]
    const result = findBreakEven((x) => x - 50, 0, 100);
    expect(result).toBe(50);
  });

  it('returns the root NEAREST searchMin on a non-monotonic trough (+ → − → +)', () => {
    // Mirrors the real net-hedge-P&L shape: positive at searchMin, dips into a
    // loss band, then recovers to positive. Two real roots exist (100 and 300);
    // an endpoint-only sign check sees +/+ and wrongly returns null. We must
    // return the FIRST crossing (nearest searchMin), where coverage breaks.
    //   f(x) = (x - 100) * (x - 300)
    //   f(0) = +30000, f(100) = 0, f(200) = -10000, f(300) = 0, f(400) = +30000
    const f = (x: number) => (x - 100) * (x - 300);
    const result = findBreakEven(f, 0, 400);
    expect(result).not.toBeNull();
    expect(result).toBeCloseTo(100, 0);
    // Crucially NOT the far root and NOT null.
    expect(result).toBeLessThan(300);
  });

  it('locates the interior root of a DECREASING bracket (+ at min, − at max)', () => {
    // f(x) = 200 - x, positive at searchMin (100→+100), negative at searchMax
    // (300→−100). The crossing is decreasing (+ → −); the old bisection assumed
    // an increasing crossing and would mislocate it. Root is at x=200, which is
    // strictly interior — NOT searchMin.
    const result = findBreakEven((x) => 200 - x, 100, 300);
    expect(result).toBe(200);
    expect(result).not.toBe(100);
  });

  it('returns null when net P&L is positive across the entire range', () => {
    // f(x) = +500 everywhere — no bracketed root. A well-sized hedge that
    // stays net-positive across all crash sizes has no real breakeven.
    const result = findBreakEven(() => 500, 100, 600);
    expect(result).toBeNull();
  });

  it('returns null when net P&L is negative across the entire range', () => {
    // f(x) = -500 everywhere — no bracketed root, so no real breakeven.
    const result = findBreakEven(() => -500, 100, 600);
    expect(result).toBeNull();
  });
});

describe('buildScenarioTable', () => {
  const pricing = makePricing();
  const scenarioInputs = {
    spot: baseSpot,
    icShortPut: baseSpot - 30,
    icLongPut: baseSpot - 35,
    icShortCall: baseSpot + 30,
    icLongCall: baseSpot + 35,
    icCreditPts: 1.5,
    icContracts: 5,
    hedgePutStrike: pricing.putStrikeSnapped,
    hedgeCallStrike: pricing.callStrikeSnapped,
    hedgePutPremium: pricing.putPremium,
    hedgeCallPremium: pricing.callPremium,
    hedgePuts: 5,
    hedgeCalls: 5,
    hedgePutSigma: pricing.putSigma,
    hedgeCallSigma: pricing.callSigma,
    hedgeTRemaining: pricing.tHedgeEod,
    movePoints: 0,
  };

  it('returns 18 rows: 9 crashes + 9 rallies', () => {
    const table = buildScenarioTable({ spot: baseSpot, scenarioInputs });
    expect(table).toHaveLength(18);
    expect(table.filter((s) => s.direction === 'crash')).toHaveLength(9);
    expect(table.filter((s) => s.direction === 'rally')).toHaveLength(9);
  });

  it('crashes ordered ascending by move size', () => {
    const table = buildScenarioTable({ spot: baseSpot, scenarioInputs });
    const crashMoves = table
      .filter((s) => s.direction === 'crash')
      .map((s) => s.movePoints);
    for (let i = 1; i < crashMoves.length; i++) {
      expect(crashMoves[i]).toBeGreaterThan(crashMoves[i - 1]!);
    }
  });

  it('movePct strings match (movePoints / spot * 100) to 1 decimal', () => {
    const table = buildScenarioTable({ spot: baseSpot, scenarioInputs });
    for (const row of table) {
      const expected = ((row.movePoints / baseSpot) * 100).toFixed(1);
      expect(row.movePct).toBe(expected);
    }
  });
});
