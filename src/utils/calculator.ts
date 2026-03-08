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
} from '../types';
import { MARKET, DELTA_Z_SCORES, DELTA_OPTIONS, DEFAULTS, IV_MODES } from '../constants';

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
  const pdf = Math.exp(-absX * absX / 2) / Math.sqrt(2 * Math.PI);
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
  return Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
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
  type: 'call' | 'put'
): number {
  if (T <= 0 || sigma <= 0 || strike <= 0 || spot <= 0) return 0;

  const sqrtT = Math.sqrt(T);
  const sigmaRootT = sigma * sqrtT;
  const d1 = (Math.log(spot / strike) + (sigma * sigma / 2) * T) / sigmaRootT;

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
  const d1 = (Math.log(spot / strike) + (sigma * sigma / 2) * T) / sigmaRootT;

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
  type: 'call' | 'put'
): number {
  if (T <= 0 || sigma <= 0 || strike <= 0 || spot <= 0) return 0;

  const sqrtT = Math.sqrt(T);
  const sigmaRootT = sigma * sqrtT;
  const d1 = (Math.log(spot / strike) + (sigma * sigma / 2) * T) / sigmaRootT;
  const d2 = d1 - sigmaRootT;

  if (type === 'call') {
    return spot * normalCDF(d1) - strike * normalCDF(d2);
  }
  // put
  return strike * normalCDF(-d2) - spot * normalCDF(-d1);
}

/**
 * Validates that a given time (in ET, 24h format) falls within market hours.
 * Returns hours remaining if valid, error message if not.
 */
export function validateMarketTime(hour: number, minute: number): TimeValidation {
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
  params: { vix?: number; multiplier?: number; directIV?: number }
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
export function snapToIncrement(strike: number, increment: number = DEFAULTS.STRIKE_INCREMENT): number {
  return Math.round(strike / increment) * increment;
}

/**
 * Calculates the skew-adjusted sigma for a given z-score.
 * Skew is scaled proportionally to z relative to the reference z-score (10Δ).
 * Further OTM strikes (higher z) get more skew, nearer OTM (lower z) get less.
 * This models the real volatility smile where far OTM puts have steeper skew.
 *
 * Example with 3% skew at 10Δ reference:
 *   5Δ (z=1.645): put σ = σ × (1 + 0.03 × 1.645/1.28) = σ × 1.0386
 *  10Δ (z=1.280): put σ = σ × (1 + 0.03 × 1.280/1.28) = σ × 1.03    (reference)
 *  20Δ (z=0.842): put σ = σ × (1 + 0.03 × 0.842/1.28) = σ × 1.0197
 */
export function calcScaledSkew(skew: number, z: number): number {
  if (skew === 0) return 0;
  return skew * (z / DEFAULTS.SKEW_REFERENCE_Z);
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
 * Skew is z-scaled: further OTM strikes get proportionally more skew,
 * modeling the real volatility smile shape.
 */
export function calcStrikes(
  spotPrice: number,
  sigma: number,
  T: number,
  delta: DeltaTarget,
  skew: number = 0
): StrikeResult | StrikeError {
  const z = DELTA_Z_SCORES[delta];
  if (z === undefined) {
    return { error: `No z-score for delta ${String(delta)}` };
  }

  const sqrtT = Math.sqrt(T);
  const scaledSkew = calcScaledSkew(skew, z);
  const putSigma = sigma * (1 + scaledSkew);
  const callSigma = sigma * (1 - scaledSkew);

  // Drift correction: (σ²/2) × T
  const putDrift = (putSigma * putSigma / 2) * T;
  const callDrift = (callSigma * callSigma / 2) * T;

  const putStrike = Math.round(spotPrice * Math.exp(-z * putSigma * sqrtT + putDrift));
  const callStrike = Math.round(spotPrice * Math.exp(z * callSigma * sqrtT + callDrift));

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
export function isStrikeError(result: StrikeResult | StrikeError): result is StrikeError {
  return 'error' in result;
}

/**
 * Calculates strikes and theoretical premiums for all delta targets.
 * spxToSpyRatio is used for SPY equivalents (default 10).
 */
export function calcAllDeltas(
  spotPrice: number,
  sigma: number,
  T: number,
  skew: number = 0,
  spxToSpyRatio: number = 10
): ReadonlyArray<DeltaRow | DeltaRowError> {
  return DELTA_OPTIONS.map((d: DeltaTarget): DeltaRow | DeltaRowError => {
    const result = calcStrikes(spotPrice, sigma, T, d, skew);

    if (isStrikeError(result)) {
      return { delta: d, error: result.error };
    }

    const putSigma = sigma * (1 + calcScaledSkew(skew, DELTA_Z_SCORES[d]));
    const callSigma = sigma * (1 - calcScaledSkew(skew, DELTA_Z_SCORES[d]));
    const spyPutRaw = result.putStrike / spxToSpyRatio;
    const spyCallRaw = result.callStrike / spxToSpyRatio;

    const putPremium = blackScholesPrice(spotPrice, result.putStrikeSnapped, putSigma, T, 'put');
    const callPremium = blackScholesPrice(spotPrice, result.callStrikeSnapped, callSigma, T, 'call');

    // Actual BS Greeks at the snapped strikes
    const putActualDelta = calcBSDelta(spotPrice, result.putStrikeSnapped, putSigma, T, 'put');
    const callActualDelta = calcBSDelta(spotPrice, result.callStrikeSnapped, callSigma, T, 'call');
    const putGamma = calcBSGamma(spotPrice, result.putStrikeSnapped, putSigma, T);
    const callGamma = calcBSGamma(spotPrice, result.callStrikeSnapped, callSigma, T);

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
  T: number
): number {
  if (T <= 0 || putSigma <= 0 || callSigma <= 0 || beLow <= 0 || beHigh <= 0) return 0;

  const sqrtT = Math.sqrt(T);

  // P(S_T > BE_low) using put-side sigma
  const d2Low = (Math.log(spot / beLow) - (putSigma * putSigma / 2) * T) / (putSigma * sqrtT);
  const pAboveLow = normalCDF(d2Low);

  // P(S_T < BE_high) using call-side sigma
  const d2High = (Math.log(spot / beHigh) - (callSigma * callSigma / 2) * T) / (callSigma * sqrtT);
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
  side: 'put' | 'call'
): number {
  if (T <= 0 || sigma <= 0 || breakeven <= 0 || spot <= 0) return 0;

  const sqrtT = Math.sqrt(T);
  const d2 = (Math.log(spot / breakeven) - (sigma * sigma / 2) * T) / (sigma * sqrtT);

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
  spxToSpyRatio: number = 10
): IronCondorLegs {
  const shortPut = row.putSnapped;
  const longPut = shortPut - wingWidthSpx;
  const shortCall = row.callSnapped;
  const longCall = shortCall + wingWidthSpx;

  const shortPutPremium = blackScholesPrice(spotPrice, shortPut, row.putSigma, T, 'put');
  const longPutPremium = blackScholesPrice(spotPrice, longPut, row.putSigma, T, 'put');
  const shortCallPremium = blackScholesPrice(spotPrice, shortCall, row.callSigma, T, 'call');
  const longCallPremium = blackScholesPrice(spotPrice, longCall, row.callSigma, T, 'call');

  // Combined IC
  const creditReceived = (shortPutPremium - longPutPremium) + (shortCallPremium - longCallPremium);
  const maxProfit = creditReceived;
  const maxLoss = wingWidthSpx - creditReceived;
  const breakEvenLow = shortPut - creditReceived;
  const breakEvenHigh = shortCall + creditReceived;
  const returnOnRisk = maxLoss > 0 ? creditReceived / maxLoss : 0;
  const probabilityOfProfit = calcPoP(spotPrice, breakEvenLow, breakEvenHigh, row.putSigma, row.callSigma, T);

  // Per-side: put credit spread
  const putSpreadCredit = shortPutPremium - longPutPremium;
  const putSpreadMaxLoss = wingWidthSpx - putSpreadCredit;
  const putSpreadBE = shortPut - putSpreadCredit;
  const putSpreadRoR = putSpreadMaxLoss > 0 ? putSpreadCredit / putSpreadMaxLoss : 0;
  const putSpreadPoP = calcSpreadPoP(spotPrice, putSpreadBE, row.putSigma, T, 'put');

  // Per-side: call credit spread
  const callSpreadCredit = shortCallPremium - longCallPremium;
  const callSpreadMaxLoss = wingWidthSpx - callSpreadCredit;
  const callSpreadBE = shortCall + callSpreadCredit;
  const callSpreadRoR = callSpreadMaxLoss > 0 ? callSpreadCredit / callSpreadMaxLoss : 0;
  const callSpreadPoP = calcSpreadPoP(spotPrice, callSpreadBE, row.callSigma, T, 'call');

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
