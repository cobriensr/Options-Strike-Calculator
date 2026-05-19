/**
 * Hedge module barrel + `calcHedge` orchestrator.
 *
 * The pre-Phase-2Q `src/utils/hedge.ts` lived as one 632-LOC file.
 * After the split, the same public API is exposed via this folder:
 *
 *   constants.ts  — CRASH_SCENARIO_PCTS, BREAKEVEN_*
 *   pricing.ts    — stressedSigma, HedgeLegPricing, priceHedgeLegs
 *   scenarios.ts  — computeScenarioPnL, findBreakEven, buildScenarioTable
 *   sizing.ts     — HedgeContractRecommendation, recommendHedgeContracts
 *   index.ts      — calcHedge orchestrator + re-exports
 *
 * Spec: docs/superpowers/specs/frontend-cleanup-tiers-1-2-3-2026-05-18.md (Phase 2Q)
 */

import { DEFAULTS, SPX_MULTIPLIER, STRESS } from '../../constants/index.js';
import type { HedgeDelta, HedgeResult } from '../../types/index.js';
import { calcBSVega } from '../black-scholes.js';
import { BREAKEVEN_SEARCH_PCT } from './constants.js';
import { priceHedgeLegs } from './pricing.js';
import {
  computeScenarioPnL,
  findBreakEven,
  buildScenarioTable,
} from './scenarios.js';
import { recommendHedgeContracts } from './sizing.js';

// Re-exports preserve the pre-split public API. Consumers can keep
// importing `stressedSigma`, `priceHedgeLegs`, etc. from this barrel
// without knowing about the internal file layout.
export {
  stressedSigma,
  priceHedgeLegs,
  type HedgeLegPricing,
} from './pricing.js';
export {
  recommendHedgeContracts,
  type HedgeContractRecommendation,
} from './sizing.js';
export {
  buildScenarioTable,
  computeScenarioPnL,
  findBreakEven,
} from './scenarios.js';
export { CRASH_SCENARIO_PCTS } from './constants.js';

/**
 * Calculates full hedge recommendation for an IC position.
 *
 * The sizing algorithm targets breakeven at 1.5× the distance from spot
 * to the hedge strike. This is a standard reinsurance sizing approach:
 * - Below 1×: hedge hasn't started paying (deductible zone)
 * - At 1×: hedge is ATM (starts paying)
 * - At 1.5×: hedge covers the full IC max loss (target)
 * - Above 1.5×: hedge exceeds IC loss (profit on catastrophe)
 *
 * Hedge pricing uses the specified DTE (default 7 days). The scenario
 * table values hedges at (DTE - 1 day) remaining to model "sell to close
 * at EOD" — capturing the extrinsic value a longer-dated hedge retains.
 *
 * Composition:
 *   1. `priceHedgeLegs` — strike selection + premium + EOD recovery.
 *   2. `recommendHedgeContracts` — target-payout contract sizing.
 *   3. Daily cost + vega + breakeven derivation (cheap glue).
 *   4. `buildScenarioTable` — crash/rally grid.
 */
export function calcHedge(params: {
  spot: number;
  sigma: number;
  T: number;
  skew: number;
  icContracts: number;
  icCreditPts: number;
  icMaxLossPts: number;
  icShortPut: number;
  icLongPut: number;
  icShortCall: number;
  icLongCall: number;
  hedgeDelta: HedgeDelta;
  hedgeDte?: number;
  breakevenTarget?: number;
}): HedgeResult {
  const {
    spot,
    sigma,
    T,
    skew,
    icContracts,
    icCreditPts,
    icMaxLossPts,
    hedgeDelta,
    hedgeDte = DEFAULTS.HEDGE_DTE,
    breakevenTarget = STRESS.BREAKEVEN_TARGET,
  } = params;

  // 1. Strike + premium pipeline.
  const pricing = priceHedgeLegs({
    spot,
    sigma,
    T,
    skew,
    hedgeDelta,
    hedgeDte,
  });
  const {
    putStrike,
    callStrike,
    putStrikeSnapped,
    callStrikeSnapped,
    putSigma,
    callSigma,
    putPremium,
    callPremium,
    putRecovery,
    callRecovery,
    tHedgeEntry,
    tHedgeEod,
  } = pricing;

  // 2. Target-payout contract sizing.
  const { recommendedPuts, recommendedCalls } = recommendHedgeContracts({
    spot,
    pricing,
    icContracts,
    icMaxLossPts,
    breakevenTarget,
  });

  // 3a. Daily cost = premium paid - estimated EOD recovery (when OTM).
  const netPutCostPts = putPremium - putRecovery;
  const netCallCostPts = callPremium - callRecovery;
  const dailyCostPts =
    netPutCostPts * recommendedPuts + netCallCostPts * recommendedCalls;
  const dailyCostDollars = Math.round(dailyCostPts * SPX_MULTIPLIER);
  const netCreditAfterHedge = Math.round(
    icCreditPts * SPX_MULTIPLIER * icContracts - dailyCostDollars,
  );

  // 3b. Vega per 1% IV move per leg, then position-weighted total.
  const putVegaRaw = calcBSVega(spot, putStrikeSnapped, putSigma, tHedgeEntry);
  const callVegaRaw = calcBSVega(
    spot,
    callStrikeSnapped,
    callSigma,
    tHedgeEntry,
  );
  const vegaScale = 0.01 * SPX_MULTIPLIER;
  const putVegaPer1Pct = Math.round(putVegaRaw * vegaScale * 100) / 100;
  const callVegaPer1Pct = Math.round(callVegaRaw * vegaScale * 100) / 100;
  const totalVegaPer1Pct =
    Math.round(
      (putVegaPer1Pct * recommendedPuts + callVegaPer1Pct * recommendedCalls) *
        100,
    ) / 100;

  // 3c. Breakeven crash/rally — bisect over the scenario P&L.
  const scenarioInputs = {
    spot,
    icShortPut: params.icShortPut,
    icLongPut: params.icLongPut,
    icShortCall: params.icShortCall,
    icLongCall: params.icLongCall,
    icCreditPts,
    icContracts,
    hedgePutStrike: putStrikeSnapped,
    hedgeCallStrike: callStrikeSnapped,
    hedgePutPremium: putPremium,
    hedgeCallPremium: callPremium,
    hedgePuts: recommendedPuts,
    hedgeCalls: recommendedCalls,
    hedgePutSigma: putSigma,
    hedgeCallSigma: callSigma,
    hedgeTRemaining: tHedgeEod,
    movePoints: 0, // placeholder; overridden per call
  };

  const netPnLAtCrash = (pts: number) =>
    computeScenarioPnL({ ...scenarioInputs, movePoints: pts }).netPnL;
  const netPnLAtRally = (pts: number) =>
    computeScenarioPnL({ ...scenarioInputs, movePoints: -pts }).netPnL;

  // IC becomes losing when move > (spot - shortPut), so search from there.
  const distToShortPut = spot - params.icShortPut;
  const distToShortCall = params.icShortCall - spot;
  const breakEvenCrashPts = findBreakEven(
    (move) => netPnLAtCrash(move),
    distToShortPut,
    spot * BREAKEVEN_SEARCH_PCT,
  );
  const breakEvenRallyPts = findBreakEven(
    (move) => netPnLAtRally(move),
    distToShortCall,
    spot * BREAKEVEN_SEARCH_PCT,
  );

  // 4. Scenario grid.
  const scenarios = buildScenarioTable({ spot, scenarioInputs });

  return {
    hedgeDelta,
    hedgeDte,
    putStrike,
    callStrike,
    putStrikeSnapped,
    callStrikeSnapped,
    putPremium: Math.round(putPremium * 100) / 100,
    callPremium: Math.round(callPremium * 100) / 100,
    putRecovery: Math.round(putRecovery * 100) / 100,
    callRecovery: Math.round(callRecovery * 100) / 100,
    recommendedPuts,
    recommendedCalls,
    dailyCostPts: Math.round(dailyCostPts * 100) / 100,
    dailyCostDollars,
    breakEvenCrashPts,
    breakEvenRallyPts,
    netCreditAfterHedge,
    putVegaPer1Pct,
    callVegaPer1Pct,
    totalVegaPer1Pct,
    scenarios,
  };
}
