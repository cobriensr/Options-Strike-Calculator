import {
  MARKET,
  DEFAULTS,
  HEDGE_Z_SCORES,
  SPX_MULTIPLIER,
  STRESS,
} from '../constants/index.js';
import type { HedgeDelta, HedgeResult, HedgeScenario } from '../types/index.js';
import { blackScholesPrice, calcBSVega } from './black-scholes.js';
import {
  snapToIncrement,
  calcScaledSkew,
  calcScaledCallSkew,
} from './strikes.js';

// ============================================================
// HEDGE (REINSURANCE) CALCULATOR
// ============================================================

// ── Module constants ──────────────────────────────────────────────────

/**
 * Crash/rally scenario sizes as a fraction of spot. Each value generates
 * one row in each direction of the scenario table; e.g. 0.015 → 1.5%
 * crash AND 1.5% rally. Values were picked to span the trading-relevant
 * range (1.5% covers a normal trend day, 10% covers a 2020-COVID-style
 * tail). Changing this list changes the row count returned in
 * `HedgeResult.scenarios` — downstream UI assumes 9 per direction.
 */
const CRASH_SCENARIO_PCTS = [
  0.015, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.1,
] as const;

/**
 * Bisection iteration cap when solving for the breakeven crash/rally.
 * 50 iterations bracket the answer to roughly `(searchMax / 2^50)` ≈
 * 10⁻¹⁵, which is well below the `Math.round` precision used on the
 * returned points value — anything beyond ~30 iterations is wasted work
 * but keeping 50 leaves margin if `searchMax` is later widened.
 */
const BREAKEVEN_MAX_ITER = 50;

/**
 * Upper bound on the breakeven search (as a fraction of spot). 15% is
 * comfortably beyond every historical 1-day SPX move; pushing it higher
 * gains nothing for realistic inputs but expands the dead-band where
 * the bisection brackets a solution that doesn't exist.
 */
const BREAKEVEN_SEARCH_PCT = 0.15;

// ── Public utilities ──────────────────────────────────────────────────

/**
 * Estimates the IV multiplier under stress for hedge repricing.
 *
 * Empirically, VIX increases roughly 3-5 points per 1% SPX decline
 * (the "leverage effect"). For a 2% crash, VIX might go from 18 to 26-28,
 * a ~50% increase. For rallies the effect is weaker (~1-2 pts per 1%).
 *
 * Model: σ_stressed = σ × (1 + sensitivity × movePct)
 *   Crash (movePct > 0): sensitivity = 4.0 (VIX rises ~4 pts per 1% SPX drop)
 *   Rally (movePct < 0): sensitivity = 1.5 (VIX drops ~1.5 pts per 1% SPX rise)
 * Capped at 3× to avoid extreme values.
 */
export function stressedSigma(baseSigma: number, movePct: number): number {
  const absPct = Math.abs(movePct);
  const sensitivity =
    movePct > 0 ? STRESS.CRASH_SENSITIVITY : STRESS.RALLY_SENSITIVITY;
  const mult = 1 + sensitivity * absPct;
  return baseSigma * Math.min(mult, STRESS.MAX_MULT);
}

// ── Internal scenario / breakeven helpers ─────────────────────────────

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
function computeScenarioPnL(params: {
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
 */
function findBreakEven(
  computeFn: (move: number) => number,
  searchMin: number,
  searchMax: number,
): number {
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

// ── Decomposed building blocks ────────────────────────────────────────

export interface HedgeLegPricing {
  /** Raw computed strike before snapping to the nearest 5-pt SPX increment. */
  putStrike: number;
  callStrike: number;
  /** Strike snapped to the actual SPX strike grid — what the order goes to. */
  putStrikeSnapped: number;
  callStrikeSnapped: number;
  /** Skew-adjusted IVs used to price each leg. */
  putSigma: number;
  callSigma: number;
  /** Premium paid per contract for each leg, in SPX points. */
  putPremium: number;
  callPremium: number;
  /** EOD recovery value if the underlying is unchanged at EOD close. */
  putRecovery: number;
  callRecovery: number;
  /**
   * Annualized time to expiry at hedge entry (hedgeDte calendar days).
   * Calendar-day annualized — see FE-MATH-008 in `calcHedge`.
   */
  tHedgeEntry: number;
  /**
   * Annualized time remaining at EOD close, one calendar day after
   * entry. `Math.max(0, ...)` so a 1DTE hedge resolves to 0.
   */
  tHedgeEod: number;
}

/**
 * Price the four hedge legs (put strike + premium, call strike + premium)
 * plus the EOD-close recovery if the underlying doesn't move. Pure: no
 * sizing, no scenario generation. Extracted so that the strike+premium
 * pipeline can be unit-tested independently of the recommend/scenario
 * stages.
 */
export function priceHedgeLegs(params: {
  spot: number;
  sigma: number;
  T: number;
  skew: number;
  hedgeDelta: HedgeDelta;
  hedgeDte: number;
}): HedgeLegPricing {
  const { spot, sigma, T, skew, hedgeDelta, hedgeDte } = params;
  const z = HEDGE_Z_SCORES[hedgeDelta];
  const sqrtT = Math.sqrt(T);

  // Calculate hedge strikes using same formula as main calculator
  // (strikes are placed at the 0DTE equivalent distance)
  const putSkew = calcScaledSkew(skew, z);
  const callSkew = calcScaledCallSkew(skew, z);
  const putSigma = sigma * (1 + putSkew);
  const callSigma = sigma * (1 - callSkew);
  const putDrift = ((putSigma * putSigma) / 2) * T;
  const callDrift = ((callSigma * callSigma) / 2) * T;

  const putStrike = Math.round(
    spot * Math.exp(-z * putSigma * sqrtT + putDrift),
  );
  const callStrike = Math.round(
    spot * Math.exp(z * callSigma * sqrtT - callDrift),
  );
  const putStrikeSnapped = snapToIncrement(putStrike);
  const callStrikeSnapped = snapToIncrement(callStrike);

  // Price the hedge options at the specified DTE.
  //
  // DELIBERATE DIVERGENCE — audit FE-MATH-008:
  // The hedge is held OVERNIGHT (buy EOD, sell next-day EOD), so calendar
  // days pass during the holding period — not trading days. Annualizing
  // hedgeDte with CALENDAR_DAYS_PER_YEAR (365) instead of TRADING_DAYS_PER_YEAR
  // (252) gives an honest theta model; the 252-day base under-stated theta
  // by ~10% on a 7-day hedge. The rest of the codebase (black-scholes,
  // iron-condor) correctly uses the 252-day base for intraday 0DTE theta
  // where only trading-session time is relevant.
  const tHedgeEntry = hedgeDte / MARKET.CALENDAR_DAYS_PER_YEAR;
  const putPremium = blackScholesPrice(
    spot,
    putStrikeSnapped,
    putSigma,
    tHedgeEntry,
    'put',
  );
  const callPremium = blackScholesPrice(
    spot,
    callStrikeSnapped,
    callSigma,
    tHedgeEntry,
    'call',
  );

  // T remaining at EOD close: (hedgeDte - 1) calendar days.
  // Uses calendar-day annualization for the same reason as tHedgeEntry
  // (see FE-MATH-008 comment above) — the EOD close is one overnight later.
  const tHedgeEod = Math.max(0, (hedgeDte - 1) / MARKET.CALENDAR_DAYS_PER_YEAR);

  // EOD recovery if price doesn't move (used by the daily-cost calc).
  const putRecovery =
    tHedgeEod > 0
      ? blackScholesPrice(spot, putStrikeSnapped, putSigma, tHedgeEod, 'put')
      : 0;
  const callRecovery =
    tHedgeEod > 0
      ? blackScholesPrice(spot, callStrikeSnapped, callSigma, tHedgeEod, 'call')
      : 0;

  return {
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
  };
}

export interface HedgeContractRecommendation {
  recommendedPuts: number;
  recommendedCalls: number;
}

/**
 * Recommend put/call hedge contract counts targeting an IC max-loss
 * payout at `breakevenTarget × distanceToHedgeStrike`. Sized using the
 * NET payout (BS value at EOD minus entry premium) per contract — that's
 * the actual P&L each contract generates at the target move. Contracts
 * are floored at 1 even when the target payout is non-positive so the
 * UI always displays a buyable size.
 */
export function recommendHedgeContracts(params: {
  spot: number;
  pricing: HedgeLegPricing;
  icContracts: number;
  icMaxLossPts: number;
  breakevenTarget: number;
}): HedgeContractRecommendation {
  const { spot, pricing, icContracts, icMaxLossPts, breakevenTarget } = params;
  const {
    putStrikeSnapped,
    callStrikeSnapped,
    putSigma,
    callSigma,
    putPremium,
    callPremium,
    tHedgeEod,
  } = pricing;

  // IC max loss in dollars (total position)
  const icMaxLossDollars = icMaxLossPts * SPX_MULTIPLIER * icContracts;

  // Distance from spot to hedge strikes
  const distToPutHedge = spot - putStrikeSnapped;
  const distToCallHedge = callStrikeSnapped - spot;

  // Target crash: breakevenTarget × distance to hedge strike
  const targetPutSpot = spot - distToPutHedge * breakevenTarget;
  const targetCallSpot = spot + distToCallHedge * breakevenTarget;

  const putValueAtTarget =
    tHedgeEod > 0
      ? blackScholesPrice(
          targetPutSpot,
          putStrikeSnapped,
          putSigma,
          tHedgeEod,
          'put',
        )
      : Math.max(0, putStrikeSnapped - targetPutSpot);
  const callValueAtTarget =
    tHedgeEod > 0
      ? blackScholesPrice(
          targetCallSpot,
          callStrikeSnapped,
          callSigma,
          tHedgeEod,
          'call',
        )
      : Math.max(0, targetCallSpot - callStrikeSnapped);

  const putPayoutAtTarget =
    Math.max(0, putValueAtTarget - putPremium) * SPX_MULTIPLIER;
  const callPayoutAtTarget =
    Math.max(0, callValueAtTarget - callPremium) * SPX_MULTIPLIER;

  const recommendedPuts =
    putPayoutAtTarget > 0
      ? Math.max(1, Math.round(icMaxLossDollars / putPayoutAtTarget))
      : 1;
  const recommendedCalls =
    callPayoutAtTarget > 0
      ? Math.max(1, Math.round(icMaxLossDollars / callPayoutAtTarget))
      : 1;

  return { recommendedPuts, recommendedCalls };
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

// ── Public orchestrator ───────────────────────────────────────────────

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
