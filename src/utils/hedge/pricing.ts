/**
 * Hedge pricing primitives: stress-adjusted IV + the four-leg
 * strike/premium pipeline.
 *
 * Extracted from `hedge.ts` during the Phase 2Q split so the
 * strike+premium stage can be unit-tested independently of sizing
 * and scenarios. Zero logic change vs the pre-split version.
 *
 * Spec: docs/superpowers/specs/frontend-cleanup-tiers-1-2-3-2026-05-18.md (Phase 2Q)
 */

import { MARKET, HEDGE_Z_SCORES, STRESS } from '../../constants/index.js';
import type { HedgeDelta } from '../../types/index.js';
import { blackScholesPrice } from '../black-scholes.js';
import {
  snapToIncrement,
  calcScaledSkew,
  calcScaledCallSkew,
} from '../strikes.js';

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
