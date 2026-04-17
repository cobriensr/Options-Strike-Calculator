import {
  DEFAULTS,
  DEFAULT_SPX_SPY_RATIO,
  getKurtosisFactor,
  type KurtosisPair,
} from '../constants/index.js';
import type { DeltaRow, IronCondorLegs } from '../types/index.js';
import { normalCDF, blackScholesPrice } from './black-scholes.js';
import { snapToSpyHalf } from './formatting.js';
import { calcTimeToExpiry } from './time.js';

/**
 * Adjusts a log-normal PoP for fat-tailed (leptokurtic) intraday returns.
 *
 * SPX has negative return skew — crashes are sharper than rallies.
 * The kurtosis pair provides asymmetric factors:
 *   - 'put' side uses crash factor (higher — more conservative)
 *   - 'call' side uses rally factor (lower)
 *
 * For a single spread:
 *   PoP_adjusted = 1 - min(1, (1 - PoP_lognormal) × factor)
 */
export function adjustPoPForKurtosis(
  popLogNormal: number,
  kurtosis: KurtosisPair = DEFAULTS.KURTOSIS_FACTOR,
  side: 'put' | 'call' = 'put',
): number {
  const k = side === 'put' ? kurtosis.crash : kurtosis.rally;
  if (k <= 1) return popLogNormal;
  const breachProb = 1 - popLogNormal;
  const adjustedBreach = Math.min(1, breachProb * k);
  return Math.max(0, 1 - adjustedBreach);
}

/**
 * Adjusts iron condor PoP for fat tails by inflating each tail independently.
 * Uses asymmetric kurtosis: crash factor for put-side, rally factor for call-side.
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
  kurtosis: KurtosisPair = DEFAULTS.KURTOSIS_FACTOR,
): number {
  if ((kurtosis.crash <= 1 && kurtosis.rally <= 1) || T <= 0)
    return calcPoP(spot, beLow, beHigh, putSigma, callSigma, T);

  const sqrtT = Math.sqrt(T);

  // Put-side breach: P(S_T < BE_low) — uses crash factor
  const d2Low =
    (Math.log(spot / beLow) - ((putSigma * putSigma) / 2) * T) /
    (putSigma * sqrtT);
  const pBreachLow = Math.min(1, normalCDF(-d2Low) * kurtosis.crash);

  // Call-side breach: P(S_T > BE_high) — uses rally factor
  const d2High =
    (Math.log(spot / beHigh) - ((callSigma * callSigma) / 2) * T) /
    (callSigma * sqrtT);
  const pBreachHigh = Math.min(1, normalCDF(d2High) * kurtosis.rally);

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
  // Clamp to 0 for consistency with the returnOnRisk guard below. Production
  // UI constrains wingWidthSpx > 0 via WING_OPTIONS = [5, 10, ..., 50], but
  // if a direct caller ever passes 0 (existing "zero-width spreads" test)
  // or a negative value (reverse-IC-like structure), the max-loss formula
  // is meaningless and a negative display in the red Max Loss cell would
  // be dishonest. (FE-MATH-005)
  const maxLoss = Math.max(0, wingWidthSpx - creditReceived);
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
  // Clamped to 0 per FE-MATH-005 — same rationale as the combined maxLoss above.
  const putSpreadMaxLoss = Math.max(0, wingWidthSpx - putSpreadCredit);
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
  // Clamped to 0 per FE-MATH-005 — same rationale as the combined maxLoss above.
  const callSpreadMaxLoss = Math.max(0, wingWidthSpx - callSpreadCredit);
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
    shortPutSpy: snapToSpyHalf(shortPut, spxToSpyRatio),
    longPutSpy: snapToSpyHalf(longPut, spxToSpyRatio),
    shortCallSpy: snapToSpyHalf(shortCall, spxToSpyRatio),
    longCallSpy: snapToSpyHalf(longCall, spxToSpyRatio),
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
      'put',
    ),
    adjustedCallSpreadPoP: adjustPoPForKurtosis(
      callSpreadPoP,
      getKurtosisFactor(vix),
      'call',
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
 *
 * `marketHours` defaults to 6.5 (a normal NYSE session). On NYSE half-days
 * (Black Friday, day before July 4th, Christmas Eve) the session is 3.5h
 * — pass `marketHours = 3.5` to anchor the curve to the correct open
 * premium and generate a 3.5h grid. Callers can derive the right value
 * from `useCalculation`'s `results.marketHours` field. (FE-MATH-006)
 */
export function calcThetaCurve(
  spot: number,
  sigma: number,
  strikeDistance: number,
  type: 'put' | 'call',
  marketHours: number = 6.5,
): ReadonlyArray<{
  hoursRemaining: number;
  premiumPct: number;
  thetaPerHour: number;
}> {
  if (marketHours <= 0.5) return [];

  const strike = type === 'put' ? spot - strikeDistance : spot + strikeDistance;

  // Build the hours grid: marketHours, marketHours-0.5, ..., 0.5
  // For a normal day this is [6.5, 6, 5.5, ..., 0.5] (13 entries).
  // For a half-day this is [3.5, 3, 2.5, ..., 0.5] (7 entries).
  const hours: number[] = [];
  for (let h = marketHours; h >= 0.5; h -= 0.5) {
    hours.push(h);
  }

  // Premium at market open (marketHours remaining) is the reference (100%)
  const openT = calcTimeToExpiry(marketHours);
  const openPremium = blackScholesPrice(spot, strike, sigma, openT, type);
  if (openPremium <= 0) return [];

  const result: Array<{
    hoursRemaining: number;
    premiumPct: number;
    thetaPerHour: number;
  }> = [];

  let prevPremium = openPremium;
  let prevHours = marketHours;

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
