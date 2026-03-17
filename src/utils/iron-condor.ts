import {
  DEFAULTS,
  DEFAULT_SPX_SPY_RATIO,
  getKurtosisFactor,
} from '../constants';
import type { DeltaRow, IronCondorLegs } from '../types';
import { normalCDF, blackScholesPrice } from './black-scholes';
import { calcTimeToExpiry } from './time';

/**
 * Adjusts a log-normal PoP for fat-tailed (leptokurtic) intraday returns.
 *
 * SPX intraday returns have excess kurtosis ~3-5, meaning tail events
 * happen 2-3× more often than the log-normal model predicts. This function
 * inflates the breach probability on each tail by the kurtosis factor,
 * then recomputes PoP.
 *
 * For an iron condor with breakevens BE_low and BE_high:
 *   P(breach_low) = 1 - P(S_T > BE_low)  → inflated by kurtosis
 *   P(breach_high) = 1 - P(S_T < BE_high) → inflated by kurtosis
 *   PoP_adjusted = 1 - P_adj(breach_low) - P_adj(breach_high)
 *
 * For a single spread:
 *   PoP_adjusted = 1 - min(1, (1 - PoP_lognormal) × kurtosis_factor)
 */
export function adjustPoPForKurtosis(
  popLogNormal: number,
  kurtosis: number = DEFAULTS.KURTOSIS_FACTOR,
): number {
  if (kurtosis <= 1) return popLogNormal;
  // Breach probability = 1 - PoP
  const breachProb = 1 - popLogNormal;
  // Inflate breach probability by kurtosis factor
  const adjustedBreach = Math.min(1, breachProb * kurtosis);
  return Math.max(0, 1 - adjustedBreach);
}

/**
 * Adjusts iron condor PoP for fat tails by inflating each tail independently.
 * This is more accurate than adjusting the combined PoP because IC has two
 * independent breach regions (below put BE and above call BE).
 */
export function adjustICPoPForKurtosis(
  spot: number,
  beLow: number,
  beHigh: number,
  putSigma: number,
  callSigma: number,
  T: number,
  kurtosis: number = DEFAULTS.KURTOSIS_FACTOR,
): number {
  if (kurtosis <= 1 || T <= 0)
    return calcPoP(spot, beLow, beHigh, putSigma, callSigma, T);

  const sqrtT = Math.sqrt(T);

  // Put-side breach: P(S_T < BE_low)
  const d2Low =
    (Math.log(spot / beLow) - ((putSigma * putSigma) / 2) * T) /
    (putSigma * sqrtT);
  const pBreachLow = Math.min(1, normalCDF(-d2Low) * kurtosis);

  // Call-side breach: P(S_T > BE_high)
  const d2High =
    (Math.log(spot / beHigh) - ((callSigma * callSigma) / 2) * T) /
    (callSigma * sqrtT);
  const pBreachHigh = Math.min(1, normalCDF(d2High) * kurtosis);

  return Math.max(0, Math.min(1, 1 - pBreachLow - pBreachHigh));
}

/**
 * Calculates probability of profit for an iron condor.
 *
 * PoP = P(S_T > BE_low) + P(S_T < BE_high) - 1
 *
 * This accounts for the fact that both conditions must be true
 * simultaneously (price between both breakevens), which is different
 * from multiplying individual spread PoPs.
 *
 * Uses skew-adjusted σ: putSigma for the lower BE, callSigma for the upper.
 * Under log-normal with r=0:
 *   d2 = [ln(S/K) - (σ²/2)·T] / (σ·√T)
 *   P(S_T > K) = N(d2)
 *   P(S_T < K) = N(-d2)
 */
export function calcPoP(
  spot: number,
  beLow: number,
  beHigh: number,
  putSigma: number,
  callSigma: number,
  T: number,
): number {
  if (T <= 0 || putSigma <= 0 || callSigma <= 0 || beLow <= 0 || beHigh <= 0)
    return 0;

  const sqrtT = Math.sqrt(T);

  // P(S_T > BE_low) using put-side sigma
  const d2Low =
    (Math.log(spot / beLow) - ((putSigma * putSigma) / 2) * T) /
    (putSigma * sqrtT);
  const pAboveLow = normalCDF(d2Low);

  // P(S_T < BE_high) using call-side sigma
  const d2High =
    (Math.log(spot / beHigh) - ((callSigma * callSigma) / 2) * T) /
    (callSigma * sqrtT);
  const pBelowHigh = normalCDF(-d2High);

  // PoP = P(above low) + P(below high) - 1
  // Clamp to [0, 1] for edge cases
  return Math.max(0, Math.min(1, pAboveLow + pBelowHigh - 1));
}

/**
 * Calculates probability of profit for a single credit spread.
 *
 * Put credit spread PoP: P(S_T > breakeven)  — price stays above the put BE
 * Call credit spread PoP: P(S_T < breakeven) — price stays below the call BE
 *
 * Uses d2 from the log-normal distribution with the appropriate skew-adjusted σ.
 */
export function calcSpreadPoP(
  spot: number,
  breakeven: number,
  sigma: number,
  T: number,
  side: 'put' | 'call',
): number {
  if (T <= 0 || sigma <= 0 || breakeven <= 0 || spot <= 0) return 0;

  const sqrtT = Math.sqrt(T);
  const d2 =
    (Math.log(spot / breakeven) - ((sigma * sigma) / 2) * T) / (sigma * sqrtT);

  if (side === 'put') {
    // Put credit spread profits when S_T > BE
    return Math.max(0, Math.min(1, normalCDF(d2)));
  }
  // Call credit spread profits when S_T < BE
  return Math.max(0, Math.min(1, normalCDF(-d2)));
}

/**
 * Builds iron condor legs with full P&L profile.
 * Prices all four legs via Black-Scholes.
 * Includes per-side (put spread / call spread) breakdowns.
 * Uses SPX snapped strikes as the short strikes.
 * When vix is provided, uses regime-dependent kurtosis for fat-tail adjustment.
 */
export function buildIronCondor(
  row: DeltaRow,
  wingWidthSpx: number,
  spotPrice: number,
  T: number,
  spxToSpyRatio: number = DEFAULT_SPX_SPY_RATIO,
  vix?: number,
): IronCondorLegs {
  const shortPut = row.putSnapped;
  const longPut = shortPut - wingWidthSpx;
  const shortCall = row.callSnapped;
  const longCall = shortCall + wingWidthSpx;

  const shortPutPremium = blackScholesPrice(
    spotPrice,
    shortPut,
    row.putSigma,
    T,
    'put',
  );
  const longPutPremium = blackScholesPrice(
    spotPrice,
    longPut,
    row.putSigma,
    T,
    'put',
  );
  const shortCallPremium = blackScholesPrice(
    spotPrice,
    shortCall,
    row.callSigma,
    T,
    'call',
  );
  const longCallPremium = blackScholesPrice(
    spotPrice,
    longCall,
    row.callSigma,
    T,
    'call',
  );

  // Per-side credits (needed for breakevens)
  const putSpreadCredit = shortPutPremium - longPutPremium;
  const callSpreadCredit = shortCallPremium - longCallPremium;

  // Combined IC
  const creditReceived = putSpreadCredit + callSpreadCredit;
  const maxProfit = creditReceived;
  const maxLoss = wingWidthSpx - creditReceived;
  // Each side's breakeven uses only that side's credit
  const breakEvenLow = shortPut - putSpreadCredit;
  const breakEvenHigh = shortCall + callSpreadCredit;
  const returnOnRisk = maxLoss > 0 ? creditReceived / maxLoss : 0;
  // PoP uses base σ (no IV acceleration) — measures full-session settlement probability
  const popPutSigma = row.basePutSigma ?? row.putSigma;
  const popCallSigma = row.baseCallSigma ?? row.callSigma;
  const probabilityOfProfit = calcPoP(
    spotPrice,
    breakEvenLow,
    breakEvenHigh,
    popPutSigma,
    popCallSigma,
    T,
  );

  // Per-side: put credit spread
  const putSpreadMaxLoss = wingWidthSpx - putSpreadCredit;
  const putSpreadBE = shortPut - putSpreadCredit;
  const putSpreadRoR =
    putSpreadMaxLoss > 0 ? putSpreadCredit / putSpreadMaxLoss : 0;
  const putSpreadPoP = calcSpreadPoP(
    spotPrice,
    putSpreadBE,
    popPutSigma,
    T,
    'put',
  );

  // Per-side: call credit spread
  const callSpreadMaxLoss = wingWidthSpx - callSpreadCredit;
  const callSpreadBE = shortCall + callSpreadCredit;
  const callSpreadRoR =
    callSpreadMaxLoss > 0 ? callSpreadCredit / callSpreadMaxLoss : 0;
  const callSpreadPoP = calcSpreadPoP(
    spotPrice,
    callSpreadBE,
    popCallSigma,
    T,
    'call',
  );

  return {
    delta: row.delta,
    shortPut,
    longPut,
    shortCall,
    longCall,
    shortPutSpy: Math.round((shortPut / spxToSpyRatio) * 2) / 2,
    longPutSpy: Math.round((longPut / spxToSpyRatio) * 2) / 2,
    shortCallSpy: Math.round((shortCall / spxToSpyRatio) * 2) / 2,
    longCallSpy: Math.round((longCall / spxToSpyRatio) * 2) / 2,
    wingWidthSpx,
    shortPutPremium,
    longPutPremium,
    shortCallPremium,
    longCallPremium,
    creditReceived,
    maxProfit,
    maxLoss,
    breakEvenLow,
    breakEvenHigh,
    returnOnRisk,
    probabilityOfProfit,
    putSpreadCredit,
    callSpreadCredit,
    putSpreadMaxLoss,
    callSpreadMaxLoss,
    putSpreadBE,
    callSpreadBE,
    putSpreadRoR,
    callSpreadRoR,
    putSpreadPoP,
    callSpreadPoP,
    // Fat-tail adjusted PoPs (regime-dependent kurtosis)
    adjustedPoP: adjustICPoPForKurtosis(
      spotPrice,
      breakEvenLow,
      breakEvenHigh,
      popPutSigma,
      popCallSigma,
      T,
      getKurtosisFactor(vix),
    ),
    adjustedPutSpreadPoP: adjustPoPForKurtosis(
      putSpreadPoP,
      getKurtosisFactor(vix),
    ),
    adjustedCallSpreadPoP: adjustPoPForKurtosis(
      callSpreadPoP,
      getKurtosisFactor(vix),
    ),
  };
}

/**
 * Computes the theta decay curve for a given OTM option across the trading day.
 * Returns an array of { hoursRemaining, premiumPct, thetaPerHour } objects
 * showing what % of the at-open premium remains at each hour.
 *
 * This helps determine optimal entry timing:
 * - Enter too early: sit through high-range morning with low theta
 * - Enter too late: premium already decayed, gamma risk > theta edge
 * - Sweet spot: where thetaPerHour is maximized (premium is decaying fastest)
 */
export function calcThetaCurve(
  spot: number,
  sigma: number,
  strikeDistance: number,
  type: 'put' | 'call',
): ReadonlyArray<{
  hoursRemaining: number;
  premiumPct: number;
  thetaPerHour: number;
}> {
  const strike = type === 'put' ? spot - strikeDistance : spot + strikeDistance;
  const hours = [6.5, 6, 5.5, 5, 4.5, 4, 3.5, 3, 2.5, 2, 1.5, 1, 0.5];

  // Premium at market open (6.5h) is the reference (100%)
  const openT = calcTimeToExpiry(6.5);
  const openPremium = blackScholesPrice(spot, strike, sigma, openT, type);
  if (openPremium <= 0) return [];

  const result: Array<{
    hoursRemaining: number;
    premiumPct: number;
    thetaPerHour: number;
  }> = [];

  let prevPremium = openPremium;
  let prevHours = 6.5;

  for (const h of hours) {
    const T = calcTimeToExpiry(h);
    const premium = blackScholesPrice(spot, strike, sigma, T, type);
    const pct = Math.round((premium / openPremium) * 1000) / 10; // e.g. 85.3%
    const decay = prevPremium - premium;
    const elapsed = prevHours - h;
    const thetaPerHour =
      elapsed > 0 ? Math.round((decay / openPremium) * 1000) / 10 : 0;

    result.push({ hoursRemaining: h, premiumPct: pct, thetaPerHour });

    prevPremium = premium;
    prevHours = h;
  }

  return result;
}
