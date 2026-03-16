import type {
  DeltaTarget,
  TimeValidation,
  IVResult,
  StrikeResult,
  StrikeError,
  DeltaRow,
  DeltaRowError,
  IronCondorLegs,
  IVMode,
  HedgeDelta,
  HedgeResult,
  HedgeScenario,
} from '../types';
import {
  MARKET,
  DELTA_Z_SCORES,
  DELTA_OPTIONS,
  DEFAULTS,
  IV_MODES,
  HEDGE_Z_SCORES,
} from '../constants';

// ============================================================
// CUMULATIVE NORMAL DISTRIBUTION (Abramowitz & Stegun 26.2.17)
// Accuracy: |error| < 7.5 × 10⁻⁸
// ============================================================

/**
 * Standard normal cumulative distribution function.
 * Returns P(X ≤ x) for X ~ N(0,1).
 */
export function normalCDF(x: number): number {
  const p = 0.2316419;
  const b1 = 0.31938153;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;

  const absX = Math.abs(x);
  const t = 1 / (1 + p * absX);
  const pdf = Math.exp((-absX * absX) / 2) / Math.sqrt(2 * Math.PI);
  const poly = ((((b5 * t + b4) * t + b3) * t + b2) * t + b1) * t;
  const cdf = 1 - pdf * poly;

  return x >= 0 ? cdf : 1 - cdf;
}

/**
 * Standard normal probability density function.
 * N'(x) = (1/√(2π)) × e^(-x²/2)
 * Used for gamma calculation.
 */
export function normalPDF(x: number): number {
  return Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI);
}

/**
 * Black-Scholes delta for a European option.
 * r is assumed 0 for 0DTE.
 *
 * Call delta = N(d1)           → range [0, 1]
 * Put delta  = N(d1) - 1       → range [-1, 0]
 *
 * Returns the absolute value (unsigned) for display purposes.
 * Multiply by 100 to get conventional delta notation (e.g. 0.10 → 10Δ).
 */
export function calcBSDelta(
  spot: number,
  strike: number,
  sigma: number,
  T: number,
  type: 'call' | 'put',
): number {
  if (T <= 0 || sigma <= 0 || strike <= 0 || spot <= 0) return 0;

  const sqrtT = Math.sqrt(T);
  const sigmaRootT = sigma * sqrtT;
  const d1 = (Math.log(spot / strike) + ((sigma * sigma) / 2) * T) / sigmaRootT;

  if (type === 'call') {
    return normalCDF(d1);
  }
  // put delta = N(d1) - 1, return absolute value
  return Math.abs(normalCDF(d1) - 1);
}

/**
 * Black-Scholes gamma for a European option.
 * r is assumed 0 for 0DTE.
 * Gamma is the same for both puts and calls.
 *
 * Gamma = N'(d1) / (S × σ × √T)
 *
 * Interpretation: for each $1 move in SPX, delta changes by gamma.
 * On 0DTE, gamma is extremely high near ATM and increases as T → 0.
 */
export function calcBSGamma(
  spot: number,
  strike: number,
  sigma: number,
  T: number,
): number {
  if (T <= 0 || sigma <= 0 || strike <= 0 || spot <= 0) return 0;

  const sqrtT = Math.sqrt(T);
  const sigmaRootT = sigma * sqrtT;
  const d1 = (Math.log(spot / strike) + ((sigma * sigma) / 2) * T) / sigmaRootT;

  return normalPDF(d1) / (spot * sigmaRootT);
}

/**
 * Black-Scholes European option price.
 * r is assumed 0 for 0DTE.
 *
 * Call: S·N(d1) - K·N(d2)
 * Put:  K·N(-d2) - S·N(-d1)
 *
 * d1 = [ln(S/K) + (σ²/2)·T] / (σ·√T)
 * d2 = d1 - σ·√T
 */
export function blackScholesPrice(
  spot: number,
  strike: number,
  sigma: number,
  T: number,
  type: 'call' | 'put',
): number {
  if (T <= 0 || sigma <= 0 || strike <= 0 || spot <= 0) return 0;

  const sqrtT = Math.sqrt(T);
  const sigmaRootT = sigma * sqrtT;
  const d1 = (Math.log(spot / strike) + ((sigma * sigma) / 2) * T) / sigmaRootT;
  const d2 = d1 - sigmaRootT;

  if (type === 'call') {
    return spot * normalCDF(d1) - strike * normalCDF(d2);
  }
  // put
  return strike * normalCDF(-d2) - spot * normalCDF(-d1);
}

/**
 * Computes the intraday IV acceleration multiplier.
 * As the 0DTE session progresses, gamma acceleration causes realized IV
 * to increase. This function returns a multiplier on σ that accounts for
 * this empirically observed behavior.
 *
 * Model: mult = 1 + coeff × (1/hoursRemaining - 1/6.5)
 * At open (6.5h): 1.0x. At 2h: ~1.12x. At 1h: ~1.28x. At 0.5h: ~1.56x.
 *
 * The multiplier is capped to prevent extreme values near close.
 */
export function calcIVAcceleration(hoursRemaining: number): number {
  if (hoursRemaining >= MARKET.HOURS_PER_DAY) return 1;
  if (hoursRemaining <= 0) return DEFAULTS.IV_ACCEL_MAX;

  const baseRate = 1 / MARKET.HOURS_PER_DAY; // ~0.154
  const currentRate = 1 / hoursRemaining;
  const mult = 1 + DEFAULTS.IV_ACCEL_COEFF * (currentRate - baseRate);

  return Math.min(mult, DEFAULTS.IV_ACCEL_MAX);
}

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
 * Validates that a given time (in ET, 24h format) falls within market hours.
 * Returns hours remaining if valid, error message if not.
 */
export function validateMarketTime(
  hour: number,
  minute: number,
): TimeValidation {
  const totalMinutes = hour * 60 + minute;
  const openMinutes = MARKET.OPEN_HOUR_ET * 60 + MARKET.OPEN_MINUTE_ET;
  const closeMinutes = MARKET.CLOSE_HOUR_ET * 60 + MARKET.CLOSE_MINUTE_ET;

  if (totalMinutes < openMinutes) {
    return { valid: false, error: 'Before market open (9:30 AM ET)' };
  }
  if (totalMinutes >= closeMinutes) {
    return { valid: false, error: 'At or after market close (4:00 PM ET)' };
  }

  const hoursRemaining = (closeMinutes - totalMinutes) / 60;
  return { valid: true, hoursRemaining };
}

/**
 * Converts hours remaining in the trading day to annualized time-to-expiry (T).
 * T = hoursRemaining / (6.5 hours × 252 trading days)
 */
export function calcTimeToExpiry(hoursRemaining: number): number {
  return hoursRemaining / MARKET.ANNUAL_TRADING_HOURS;
}

/**
 * Resolves implied volatility (σ) from either VIX or direct input.
 * Single convergence point — both modes produce one σ output.
 */
export function resolveIV(
  mode: IVMode,
  params: { vix?: number; multiplier?: number; directIV?: number },
): IVResult {
  if (mode === IV_MODES.VIX) {
    const { vix, multiplier } = params;

    if (vix == null || Number.isNaN(vix) || vix < 0) {
      return { sigma: null, error: 'VIX must be a positive number' };
    }
    if (vix === 0) {
      return { sigma: null, error: 'VIX cannot be zero' };
    }
    if (
      multiplier == null ||
      Number.isNaN(multiplier) ||
      multiplier < DEFAULTS.IV_PREMIUM_MIN ||
      multiplier > DEFAULTS.IV_PREMIUM_MAX
    ) {
      return {
        sigma: null,
        error: `Multiplier must be ${DEFAULTS.IV_PREMIUM_MIN} to ${DEFAULTS.IV_PREMIUM_MAX}`,
      };
    }

    return { sigma: (vix * multiplier) / 100 };
  }

  if (mode === IV_MODES.DIRECT) {
    const { directIV } = params;

    if (directIV == null || Number.isNaN(directIV) || directIV <= 0) {
      return { sigma: null, error: 'IV must be a positive number' };
    }
    if (directIV > 2) {
      return { sigma: null, error: 'Enter as decimal (e.g. 0.20 for 20%)' };
    }

    return { sigma: directIV };
  }

  return { sigma: null, error: 'Invalid IV mode' };
}

/**
 * Snaps a strike price to the nearest increment.
 */
export function snapToIncrement(
  strike: number,
  increment: number = DEFAULTS.STRIKE_INCREMENT,
): number {
  return Math.round(strike / increment) * increment;
}

/**
 * Calculates the skew-adjusted sigma for puts at a given z-score.
 * Uses a convex (power) curve: further OTM puts get disproportionately
 * more skew, matching real SPX volatility smile behavior.
 *
 * Put skew: skew × (z / z_ref)^convexity
 *   convexity > 1 → steeper far OTM (5Δ gets ~35% more skew than linear)
 *
 * Example with 3% skew at 10Δ reference (convexity = 1.35):
 *   5Δ (z=1.645): put skew = 0.03 × (1.645/1.28)^1.35 = 0.03 × 1.38 = 4.15%
 *  10Δ (z=1.280): put skew = 0.03 × 1.00                            = 3.00%
 *  20Δ (z=0.842): put skew = 0.03 × (0.842/1.28)^1.35 = 0.03 × 0.56 = 1.69%
 */
export function calcScaledSkew(skew: number, z: number): number {
  if (skew === 0 || !Number.isFinite(z) || z <= 0) return 0;
  const ratio = z / DEFAULTS.SKEW_REFERENCE_Z;
  return skew * Math.pow(ratio, DEFAULTS.SKEW_PUT_CONVEXITY);
}

/**
 * Calculates the skew-adjusted sigma for calls at a given z-score.
 * Call skew flattens further OTM (and sometimes inverts on rally days),
 * so we dampen the skew at high z-scores.
 *
 * Call skew: skew × (z / z_ref) × dampening_factor
 *   dampening = 1 / (1 + CALL_DAMPENING × max(0, z/z_ref - 1))
 *   At 10Δ: no dampening. At 5Δ: ~15-20% less skew than linear.
 */
export function calcScaledCallSkew(skew: number, z: number): number {
  if (skew === 0 || !Number.isFinite(z) || z <= 0) return 0;
  const ratio = z / DEFAULTS.SKEW_REFERENCE_Z;
  const dampening =
    1 / (1 + DEFAULTS.SKEW_CALL_DAMPENING * Math.max(0, ratio - 1));
  return skew * ratio * dampening;
}

/**
 * Calculates put and call strikes for a given delta.
 *
 * Exact delta-targeted strike formula (with log-normal drift correction):
 *   K_put  = S × e^(-z × σ_put × √T + (σ_put²/2) × T)
 *   K_call = S × e^(+z × σ_call × √T + (σ_call²/2) × T)
 *
 * The (σ²/2)T term is the drift correction from the log-normal distribution.
 * Without it, strikes are placed ~0.5 SPX points too far OTM. Small for 0DTE
 * but mathematically correct.
 *
 * Skew uses convex put curve and dampened call curve to match
 * the real SPX volatility smile shape.
 */
export function calcStrikes(
  spotPrice: number,
  sigma: number,
  T: number,
  delta: DeltaTarget,
  skew: number = 0,
): StrikeResult | StrikeError {
  const z = DELTA_Z_SCORES[delta];
  if (z === undefined) {
    return { error: `No z-score for delta ${String(delta)}` };
  }

  const sqrtT = Math.sqrt(T);
  const putSkew = calcScaledSkew(skew, z);
  const callSkew = calcScaledCallSkew(skew, z);
  const putSigma = sigma * (1 + putSkew);
  const callSigma = sigma * (1 - callSkew);

  // Drift correction: (σ²/2) × T
  const putDrift = ((putSigma * putSigma) / 2) * T;
  const callDrift = ((callSigma * callSigma) / 2) * T;

  const putStrike = Math.round(
    spotPrice * Math.exp(-z * putSigma * sqrtT + putDrift),
  );
  const callStrike = Math.round(
    spotPrice * Math.exp(z * callSigma * sqrtT + callDrift),
  );

  return {
    putStrike,
    callStrike,
    putStrikeSnapped: snapToIncrement(putStrike),
    callStrikeSnapped: snapToIncrement(callStrike),
  };
}

/**
 * Type guard: checks if a strike result is an error.
 */
export function isStrikeError(
  result: StrikeResult | StrikeError,
): result is StrikeError {
  return 'error' in result;
}

/**
 * Calculates strikes and theoretical premiums for all delta targets.
 * spxToSpyRatio is used for SPY equivalents (default 10).
 * hoursRemaining is used for IV acceleration (default: derive from T).
 *
 * Strike placement uses the base σ (no acceleration) because strikes
 * are chosen based on the full-session probability of the move.
 * Premium pricing uses accelerated σ because it reflects current market
 * conditions and what you'd actually pay/receive now.
 */
export function calcAllDeltas(
  spotPrice: number,
  sigma: number,
  T: number,
  skew: number = 0,
  spxToSpyRatio: number = 10,
): ReadonlyArray<DeltaRow | DeltaRowError> {
  // IV acceleration based on time remaining
  const hoursRemaining = T * MARKET.ANNUAL_TRADING_HOURS;
  const ivAccelMult = calcIVAcceleration(hoursRemaining);

  return DELTA_OPTIONS.map((d: DeltaTarget): DeltaRow | DeltaRowError => {
    // Strikes placed using base σ (full-session probability)
    const result = calcStrikes(spotPrice, sigma, T, d, skew);

    if (isStrikeError(result)) {
      return { delta: d, error: result.error };
    }

    // Premiums and Greeks use accelerated σ (current market conditions)
    const accelSigma = sigma * ivAccelMult;
    const putSigma = accelSigma * (1 + calcScaledSkew(skew, DELTA_Z_SCORES[d]));
    const callSigma =
      accelSigma * (1 - calcScaledCallSkew(skew, DELTA_Z_SCORES[d]));
    const spyPutRaw = result.putStrike / spxToSpyRatio;
    const spyCallRaw = result.callStrike / spxToSpyRatio;

    const putPremium = blackScholesPrice(
      spotPrice,
      result.putStrikeSnapped,
      putSigma,
      T,
      'put',
    );
    const callPremium = blackScholesPrice(
      spotPrice,
      result.callStrikeSnapped,
      callSigma,
      T,
      'call',
    );

    // Actual BS Greeks at the snapped strikes (using accelerated σ)
    const putActualDelta = calcBSDelta(
      spotPrice,
      result.putStrikeSnapped,
      putSigma,
      T,
      'put',
    );
    const callActualDelta = calcBSDelta(
      spotPrice,
      result.callStrikeSnapped,
      callSigma,
      T,
      'call',
    );
    const putGamma = calcBSGamma(
      spotPrice,
      result.putStrikeSnapped,
      putSigma,
      T,
    );
    const callGamma = calcBSGamma(
      spotPrice,
      result.callStrikeSnapped,
      callSigma,
      T,
    );

    return {
      delta: d,
      z: DELTA_Z_SCORES[d],
      putStrike: result.putStrike,
      callStrike: result.callStrike,
      putSnapped: result.putStrikeSnapped,
      callSnapped: result.callStrikeSnapped,
      putSpySnapped: Math.round(spyPutRaw),
      callSpySnapped: Math.round(spyCallRaw),
      spyPut: spyPutRaw.toFixed(2),
      spyCall: spyCallRaw.toFixed(2),
      putDistance: spotPrice - result.putStrike,
      callDistance: result.callStrike - spotPrice,
      putPct: (((spotPrice - result.putStrike) / spotPrice) * 100).toFixed(2),
      callPct: (((result.callStrike - spotPrice) / spotPrice) * 100).toFixed(2),
      putPremium,
      callPremium,
      putSigma,
      callSigma,
      putActualDelta,
      callActualDelta,
      putGamma,
      callGamma,
      ivAccelMult,
    };
  });
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
 */
export function buildIronCondor(
  row: DeltaRow,
  wingWidthSpx: number,
  spotPrice: number,
  T: number,
  spxToSpyRatio: number = 10,
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

  // Combined IC
  const creditReceived =
    shortPutPremium - longPutPremium + (shortCallPremium - longCallPremium);
  const maxProfit = creditReceived;
  const maxLoss = wingWidthSpx - creditReceived;
  const breakEvenLow = shortPut - creditReceived;
  const breakEvenHigh = shortCall + creditReceived;
  const returnOnRisk = maxLoss > 0 ? creditReceived / maxLoss : 0;
  const probabilityOfProfit = calcPoP(
    spotPrice,
    breakEvenLow,
    breakEvenHigh,
    row.putSigma,
    row.callSigma,
    T,
  );

  // Per-side: put credit spread
  const putSpreadCredit = shortPutPremium - longPutPremium;
  const putSpreadMaxLoss = wingWidthSpx - putSpreadCredit;
  const putSpreadBE = shortPut - putSpreadCredit;
  const putSpreadRoR =
    putSpreadMaxLoss > 0 ? putSpreadCredit / putSpreadMaxLoss : 0;
  const putSpreadPoP = calcSpreadPoP(
    spotPrice,
    putSpreadBE,
    row.putSigma,
    T,
    'put',
  );

  // Per-side: call credit spread
  const callSpreadCredit = shortCallPremium - longCallPremium;
  const callSpreadMaxLoss = wingWidthSpx - callSpreadCredit;
  const callSpreadBE = shortCall + callSpreadCredit;
  const callSpreadRoR =
    callSpreadMaxLoss > 0 ? callSpreadCredit / callSpreadMaxLoss : 0;
  const callSpreadPoP = calcSpreadPoP(
    spotPrice,
    callSpreadBE,
    row.callSigma,
    T,
    'call',
  );

  return {
    delta: row.delta,
    shortPut,
    longPut,
    shortCall,
    longCall,
    shortPutSpy: Math.round(shortPut / spxToSpyRatio),
    longPutSpy: Math.round(longPut / spxToSpyRatio),
    shortCallSpy: Math.round(shortCall / spxToSpyRatio),
    longCallSpy: Math.round(longCall / spxToSpyRatio),
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
    // Fat-tail adjusted PoPs (account for leptokurtic intraday returns)
    adjustedPoP: adjustICPoPForKurtosis(
      spotPrice,
      breakEvenLow,
      breakEvenHigh,
      row.putSigma,
      row.callSigma,
      T,
    ),
    adjustedPutSpreadPoP: adjustPoPForKurtosis(putSpreadPoP),
    adjustedCallSpreadPoP: adjustPoPForKurtosis(callSpreadPoP),
  };
}

/**
 * Converts SPX strike to approximate SPY equivalent.
 */
export function spxToSpy(strike: number): string {
  return (strike / 10).toFixed(2);
}

/**
 * Converts 12-hour time to 24-hour format.
 */
export function to24Hour(hour: number, ampm: 'AM' | 'PM'): number {
  if (ampm === 'AM') return hour === 12 ? 0 : hour;
  return hour === 12 ? 12 : hour + 12;
}

// ============================================================
// HEDGE (REINSURANCE) CALCULATOR
// ============================================================

/**
 * Computes P&L for an IC + hedge position at a given SPX move.
 * movePoints > 0 = crash (SPX drops), movePoints < 0 = rally (SPX rises).
 *
 * Hedge valuation uses Black-Scholes with remaining DTE (hedgeDte - 1 day)
 * to model the extrinsic value retained when closing a 7-14 DTE hedge at EOD.
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
    (params.icCreditPts + icPutPnL + icCallPnL) * 100 * icContracts;

  // Hedge put value at EOD: BS price with remaining DTE (not intrinsic-only)
  // This models "sell to close at EOD" — the hedge retains extrinsic value
  const hedgePutEodValue =
    params.hedgeTRemaining > 0
      ? blackScholesPrice(
          sFinal,
          params.hedgePutStrike,
          params.hedgePutSigma,
          params.hedgeTRemaining,
          'put',
        )
      : Math.max(0, params.hedgePutStrike - sFinal); // fallback to intrinsic for 0DTE
  const hedgePutPnLPts = hedgePutEodValue - params.hedgePutPremium;
  const hedgePutDollars = hedgePutPnLPts * 100 * hedgePuts;

  // Hedge call value at EOD: BS price with remaining DTE
  const hedgeCallEodValue =
    params.hedgeTRemaining > 0
      ? blackScholesPrice(
          sFinal,
          params.hedgeCallStrike,
          params.hedgeCallSigma,
          params.hedgeTRemaining,
          'call',
        )
      : Math.max(0, sFinal - params.hedgeCallStrike);
  const hedgeCallPnLPts = hedgeCallEodValue - params.hedgeCallPremium;
  const hedgeCallDollars = hedgeCallPnLPts * 100 * hedgeCalls;

  // Total hedge cost (premium paid, regardless of payout — for display)
  const hedgeCostDollars = -(
    params.hedgePutPremium * 100 * hedgePuts +
    params.hedgeCallPremium * 100 * hedgeCalls
  );

  return {
    icPnL: Math.round(icPnLDollars),
    hedgePutPnL: Math.round(hedgePutEodValue * 100 * hedgePuts),
    hedgeCallPnL: Math.round(hedgeCallEodValue * 100 * hedgeCalls),
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
  for (let i = 0; i < 50; i++) {
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
  } = params;
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
    spot * Math.exp(z * callSigma * sqrtT + callDrift),
  );
  const putStrikeSnapped = snapToIncrement(putStrike);
  const callStrikeSnapped = snapToIncrement(callStrike);

  // Price the hedge options at the specified DTE
  // T_hedge = hedgeDte trading days, annualized
  const tHedgeEntry = hedgeDte / MARKET.TRADING_DAYS_PER_YEAR;
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

  // T remaining at EOD close: (hedgeDte - 1) trading days
  // This is the time value the hedge retains when sold to close
  const tHedgeEod = Math.max(0, (hedgeDte - 1) / MARKET.TRADING_DAYS_PER_YEAR);

  // IC max loss in dollars (total position)
  const icMaxLossDollars = icMaxLossPts * 100 * icContracts;

  // Distance from spot to hedge strikes
  const distToPutHedge = spot - putStrikeSnapped;
  const distToCallHedge = callStrikeSnapped - spot;

  // Target crash: 1.5× distance to hedge strike
  // Size using NET payout (BS value at EOD minus entry premium) per contract,
  // since that's the actual P&L each contract generates at the target move
  const targetPutSpot = spot - distToPutHedge * 1.5;
  const targetCallSpot = spot + distToCallHedge * 1.5;
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
  const putPayoutAtTarget = Math.max(0, putValueAtTarget - putPremium) * 100;
  const callPayoutAtTarget = Math.max(0, callValueAtTarget - callPremium) * 100;

  // Recommended contracts: enough to approximately cover IC max loss at target crash
  const recommendedPuts =
    putPayoutAtTarget > 0
      ? Math.max(1, Math.round(icMaxLossDollars / putPayoutAtTarget))
      : 1;
  const recommendedCalls =
    callPayoutAtTarget > 0
      ? Math.max(1, Math.round(icMaxLossDollars / callPayoutAtTarget))
      : 1;

  // Total daily cost = premium paid - estimated EOD recovery (when OTM)
  // If the hedge isn't needed (price stays flat), we recover most of the premium
  const putRecovery =
    tHedgeEod > 0
      ? blackScholesPrice(spot, putStrikeSnapped, putSigma, tHedgeEod, 'put')
      : 0;
  const callRecovery =
    tHedgeEod > 0
      ? blackScholesPrice(spot, callStrikeSnapped, callSigma, tHedgeEod, 'call')
      : 0;
  const netPutCostPts = putPremium - putRecovery;
  const netCallCostPts = callPremium - callRecovery;
  const dailyCostPts =
    netPutCostPts * recommendedPuts + netCallCostPts * recommendedCalls;
  const dailyCostDollars = Math.round(dailyCostPts * 100);
  const netCreditAfterHedge = Math.round(
    icCreditPts * 100 * icContracts - dailyCostDollars,
  );

  // Helper to compute net P&L at a given crash/rally size
  const scenarioParams = {
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
  };

  const netPnLAtCrash = (pts: number) =>
    computeScenarioPnL({ ...scenarioParams, movePoints: pts }).netPnL;
  const netPnLAtRally = (pts: number) =>
    computeScenarioPnL({ ...scenarioParams, movePoints: -pts }).netPnL;

  // Find breakeven points (crash/rally size where net P&L = 0)
  // IC becomes losing when move > (spot - shortPut), so search from there
  const distToShortPut = spot - params.icShortPut;
  const distToShortCall = params.icShortCall - spot;

  const breakEvenCrashPts = findBreakEven(
    (move) => netPnLAtCrash(move),
    distToShortPut, // starts losing here
    spot * 0.15, // max 15% crash
  );

  const breakEvenRallyPts = findBreakEven(
    (move) => netPnLAtRally(move),
    distToShortCall,
    spot * 0.15,
  );

  // Build scenario table: crashes and rallies at key levels
  const crashLevels = [100, 150, 200, 250, 300, 350, 400, 450, 500];
  const scenarios: HedgeScenario[] = [];

  for (const pts of crashLevels) {
    const result = computeScenarioPnL({ ...scenarioParams, movePoints: pts });
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
    const result = computeScenarioPnL({ ...scenarioParams, movePoints: -pts });
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
    scenarios,
  };
}
