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
 * Number of grid samples used to scan [searchMin, searchMax] for sign
 * changes before bisecting. Net hedge P&L vs. crash/rally size is
 * NON-MONOTONIC (it can dip into a loss band and recover), so an
 * endpoint-only sign check misses interior roots entirely. ~160 samples
 * over a ~1000-pt range is ~6-pt resolution — fine enough to bracket
 * every real crossing for realistic inputs without excessive compute.
 */
const BREAKEVEN_GRID_SAMPLES = 160;

/**
 * Finds the crash/rally size where net P&L crosses zero — i.e. where hedge
 * coverage breaks down.
 *
 * Net hedge P&L vs. move size is NON-MONOTONIC: a well-sized hedge can be
 * net-positive at the IC's loss threshold, dip negative through a loss band
 * as the IC takes its full wing loss before the hedge fully kicks in, then
 * recover to strongly positive on a large tail move. That means the endpoints
 * frequently share a sign while two (or more) real roots sit in the interior —
 * an endpoint-only sign check would return `null` and the UI would falsely
 * report "fully covered", hiding a genuine loss band.
 *
 * Strategy: sample net P&L on an even grid across [searchMin, searchMax], find
 * the FIRST adjacent pair whose sign changes (nearest `searchMin`), and bisect
 * that sub-interval. The returned value is the breakeven NEAREST `searchMin`
 * ("coverage breaks here"). Direction-agnostic: the bisection brackets on the
 * actual endpoint signs, so it locates the root whether the crossing is
 * increasing (− → +) or decreasing (+ → −).
 *
 * NOTE: a second (far) root often exists where P&L recovers back through zero
 * — out of scope for this single-value field, which models where coverage
 * first breaks. Returns `null` only when no sign change exists anywhere on the
 * grid (genuinely no breakeven across the whole range).
 */
export function findBreakEven(
  computeFn: (move: number) => number,
  searchMin: number,
  searchMax: number,
): number | null {
  if (
    !Number.isFinite(searchMin) ||
    !Number.isFinite(searchMax) ||
    searchMax <= searchMin
  ) {
    return null;
  }

  const step = (searchMax - searchMin) / BREAKEVEN_GRID_SAMPLES;

  // Sample the grid once and reuse the values — the bisection below only
  // recomputes inside the single bracketing sub-interval, so each grid point
  // is evaluated at most once here.
  let prevX = searchMin;
  let prevF = computeFn(prevX);
  if (prevF === 0) return Math.round(prevX);

  for (let i = 1; i <= BREAKEVEN_GRID_SAMPLES; i++) {
    const x = i === BREAKEVEN_GRID_SAMPLES ? searchMax : searchMin + i * step;
    const f = computeFn(x);
    if (f === 0) return Math.round(x);

    if (Math.sign(f) !== Math.sign(prevF)) {
      // First bracketing sub-interval [prevX, x] — bisect it. The bracket
      // direction (which side is + / −) is read from prevF, so this works for
      // both increasing and decreasing crossings.
      let lo = prevX;
      let hi = x;
      const loIsNegative = prevF < 0;
      for (let iter = 0; iter < BREAKEVEN_MAX_ITER; iter++) {
        const mid = (lo + hi) / 2;
        const fMid = computeFn(mid);
        // Keep the sub-interval that still straddles zero.
        if (fMid < 0 === loIsNegative) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
      return Math.round((lo + hi) / 2);
    }

    prevX = x;
    prevF = f;
  }

  return null;
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
