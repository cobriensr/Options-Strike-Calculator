/**
 * Scenario P&L + breakeven bisection helpers + the crash/rally
 * scenario table builder.
 *
 * Extracted from `hedge.ts` during the Phase 2Q split. `computeScenarioPnL`
 * and `findBreakEven` are exported because `calcHedge` (in `index.ts`)
 * also calls them to derive breakeven crash/rally points — they're not
 * scenario-only helpers any more.
 *
 * Spec: docs/superpowers/specs/frontend-cleanup-tiers-1-2-3-2026-05-18.md (Phase 2Q)
 */

import { SPX_MULTIPLIER } from '../../constants/index.js';
import type { HedgeScenario } from '../../types/index.js';
import { blackScholesPrice } from '../black-scholes.js';
import { BREAKEVEN_MAX_ITER, CRASH_SCENARIO_PCTS } from './constants.js';
import { stressedSigma } from './pricing.js';

/**
 * Computes P&L for an IC + hedge position at a given SPX move.
 * movePoints > 0 = crash (SPX drops), movePoints < 0 = rally (SPX rises).
 *
 * Hedge valuation uses Black-Scholes with remaining DTE (hedgeDte - 1 day)
 * to model the extrinsic value retained when closing a 7-14 DTE hedge at EOD.
 * Sigma is scaled by the stress model to account for IV expansion during crashes.
 * This is much more accurate than intrinsic-only, since a 7DTE hedge still has
 * ~85-95% of its theta value at EOD close.
 */
export function computeScenarioPnL(params: {
  spot: number;
  movePoints: number;
  icShortPut: number;
  icLongPut: number;
  icShortCall: number;
  icLongCall: number;
  icCreditPts: number;
  icContracts: number;
  hedgePutStrike: number;
  hedgeCallStrike: number;
  hedgePutPremium: number;
  hedgeCallPremium: number;
  hedgePuts: number;
  hedgeCalls: number;
  hedgePutSigma: number;
  hedgeCallSigma: number;
  hedgeTRemaining: number; // T for hedge at EOD close (hedgeDte - 1 day, annualized)
}): {
  icPnL: number;
  hedgePutPnL: number;
  hedgeCallPnL: number;
  hedgeCost: number;
  netPnL: number;
} {
  const { spot, movePoints, icContracts, hedgePuts, hedgeCalls } = params;
  const sFinal = spot - movePoints; // positive movePoints = crash
  const movePct = movePoints / spot; // signed: positive = crash

  // IC put side P&L (per contract, in points)
  let icPutPnL: number;
  if (sFinal >= params.icShortPut) {
    icPutPnL = 0; // put side expires OTM, keep full put credit
  } else if (sFinal >= params.icLongPut) {
    icPutPnL = -(params.icShortPut - sFinal); // partial loss
  } else {
    icPutPnL = -(params.icShortPut - params.icLongPut); // full wing loss
  }

  // IC call side P&L (per contract, in points)
  let icCallPnL: number;
  if (sFinal <= params.icShortCall) {
    icCallPnL = 0; // call side expires OTM
  } else if (sFinal <= params.icLongCall) {
    icCallPnL = -(sFinal - params.icShortCall); // partial loss
  } else {
    icCallPnL = -(params.icLongCall - params.icShortCall); // full wing loss
  }

  // IC total P&L in dollars (credit + losses on both sides)
  const icPnLDollars =
    (params.icCreditPts + icPutPnL + icCallPnL) * SPX_MULTIPLIER * icContracts;

  // Stress-adjusted sigma: IV expands on crashes, compresses on rallies
  const stressedPutSigma = stressedSigma(params.hedgePutSigma, movePct);
  const stressedCallSigma = stressedSigma(params.hedgeCallSigma, -movePct);

  // Hedge put value at EOD: BS price with remaining DTE and stressed IV
  // This models "sell to close at EOD" — the hedge retains extrinsic value
  const hedgePutEodValue =
    params.hedgeTRemaining > 0
      ? blackScholesPrice(
          sFinal,
          params.hedgePutStrike,
          stressedPutSigma,
          params.hedgeTRemaining,
          'put',
        )
      : Math.max(0, params.hedgePutStrike - sFinal); // fallback to intrinsic for 0DTE
  const hedgePutPnLPts = hedgePutEodValue - params.hedgePutPremium;
  const hedgePutDollars = hedgePutPnLPts * SPX_MULTIPLIER * hedgePuts;

  // Hedge call value at EOD: BS price with remaining DTE and stressed IV
  const hedgeCallEodValue =
    params.hedgeTRemaining > 0
      ? blackScholesPrice(
          sFinal,
          params.hedgeCallStrike,
          stressedCallSigma,
          params.hedgeTRemaining,
          'call',
        )
      : Math.max(0, sFinal - params.hedgeCallStrike);
  const hedgeCallPnLPts = hedgeCallEodValue - params.hedgeCallPremium;
  const hedgeCallDollars = hedgeCallPnLPts * SPX_MULTIPLIER * hedgeCalls;

  // Total hedge cost (premium paid, regardless of payout — for display)
  const hedgeCostDollars = -(
    params.hedgePutPremium * SPX_MULTIPLIER * hedgePuts +
    params.hedgeCallPremium * SPX_MULTIPLIER * hedgeCalls
  );

  return {
    icPnL: Math.round(icPnLDollars),
    hedgePutPnL: Math.round(hedgePutEodValue * SPX_MULTIPLIER * hedgePuts),
    hedgeCallPnL: Math.round(hedgeCallEodValue * SPX_MULTIPLIER * hedgeCalls),
    hedgeCost: Math.round(hedgeCostDollars),
    netPnL: Math.round(icPnLDollars + hedgePutDollars + hedgeCallDollars),
  };
}

/**
 * Binary search for the crash/rally size where net P&L crosses zero.
 *
 * Returns `null` when the search range does not bracket a root, i.e. when
 * net P&L shares the same sign at both endpoints. The common case is a
 * well-sized hedge that stays net-positive across the entire crash/rally
 * range (the desired outcome) — there is no real breakeven point, so we
 * report "no breakeven / fully covered" rather than a meaningless number.
 */
export function findBreakEven(
  computeFn: (move: number) => number,
  searchMin: number,
  searchMax: number,
): number | null {
  // Bisection is only meaningful when the endpoints bracket a sign change.
  // Without this guard, an all-positive function collapses to searchMin and
  // an all-negative one to searchMax — both bogus "breakevens".
  const fMin = computeFn(searchMin);
  const fMax = computeFn(searchMax);
  if (fMin === 0) return Math.round(searchMin);
  if (fMax === 0) return Math.round(searchMax);
  if (Math.sign(fMin) === Math.sign(fMax)) return null;

  let lo = searchMin;
  let hi = searchMax;
  for (let i = 0; i < BREAKEVEN_MAX_ITER; i++) {
    const mid = (lo + hi) / 2;
    if (computeFn(mid) < 0) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return Math.round((lo + hi) / 2);
}

/**
 * Generate the full crash + rally scenario grid. One row per
 * `CRASH_SCENARIO_PCTS` entry per direction, in the same order — crashes
 * first, rallies second — matching the existing UI table layout.
 */
export function buildScenarioTable(params: {
  spot: number;
  scenarioInputs: Parameters<typeof computeScenarioPnL>[0];
}): HedgeScenario[] {
  const { spot, scenarioInputs } = params;
  const crashLevels = CRASH_SCENARIO_PCTS.map((pct) => Math.round(spot * pct));
  const scenarios: HedgeScenario[] = [];

  for (const pts of crashLevels) {
    const result = computeScenarioPnL({ ...scenarioInputs, movePoints: pts });
    scenarios.push({
      movePoints: pts,
      movePct: ((pts / spot) * 100).toFixed(1),
      direction: 'crash',
      icPnL: result.icPnL,
      hedgePutPnL: result.hedgePutPnL,
      hedgeCallPnL: result.hedgeCallPnL,
      hedgeCost: result.hedgeCost,
      netPnL: result.netPnL,
    });
  }

  for (const pts of crashLevels) {
    const result = computeScenarioPnL({ ...scenarioInputs, movePoints: -pts });
    scenarios.push({
      movePoints: pts,
      movePct: ((pts / spot) * 100).toFixed(1),
      direction: 'rally',
      icPnL: result.icPnL,
      hedgePutPnL: result.hedgePutPnL,
      hedgeCallPnL: result.hedgeCallPnL,
      hedgeCost: result.hedgeCost,
      netPnL: result.netPnL,
    });
  }

  return scenarios;
}
