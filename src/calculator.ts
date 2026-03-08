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
} from './types';
import { MARKET, DELTA_Z_SCORES, DELTA_OPTIONS, DEFAULTS, IV_MODES } from './constants';

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
  const b1 = 0.319381530;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;

  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const pdf = Math.exp(-absX * absX / 2) / Math.sqrt(2 * Math.PI);
  const poly = ((((b5 * t + b4) * t + b3) * t + b2) * t + b1) * t;
  const cdf = 1.0 - pdf * poly;

  return x >= 0 ? cdf : 1.0 - cdf;
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

    if (vix == null || isNaN(vix) || vix < 0) {
      return { sigma: null, error: 'VIX must be a positive number' };
    }
    if (vix === 0) {
      return { sigma: null, error: 'VIX cannot be zero' };
    }
    if (
      multiplier == null ||
      isNaN(multiplier) ||
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

    if (directIV == null || isNaN(directIV) || directIV <= 0) {
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
 * Calculates put and call strikes for a given delta.
 * K_put = S × e^(-z × σ_put × √T)  where σ_put = σ × (1 + skew)
 * K_call = S × e^(+z × σ_call × √T) where σ_call = σ × (1 - skew)
 *
 * Skew accounts for the volatility smile: OTM puts trade at higher IV
 * than OTM calls. A skew of 0.03 means put IV is 3% above and call IV
 * is 3% below the ATM level.
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
  const putSigma = sigma * (1 + skew);
  const callSigma = sigma * (1 - skew);

  const putStrike = Math.round(spotPrice * Math.exp(-z * putSigma * sqrtT));
  const callStrike = Math.round(spotPrice * Math.exp(z * callSigma * sqrtT));

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

    const putSigma = sigma * (1 + skew);
    const callSigma = sigma * (1 - skew);
    const spyPutRaw = result.putStrike / spxToSpyRatio;
    const spyCallRaw = result.callStrike / spxToSpyRatio;

    const putPremium = blackScholesPrice(spotPrice, result.putStrikeSnapped, putSigma, T, 'put');
    const callPremium = blackScholesPrice(spotPrice, result.callStrikeSnapped, callSigma, T, 'call');

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
 * Builds iron condor legs with full P&L profile.
 * Prices all four legs via Black-Scholes.
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

  const creditReceived = (shortPutPremium - longPutPremium) + (shortCallPremium - longCallPremium);
  const maxProfit = creditReceived;
  const maxLoss = wingWidthSpx - creditReceived;
  const breakEvenLow = shortPut - creditReceived;
  const breakEvenHigh = shortCall + creditReceived;
  const returnOnRisk = maxLoss > 0 ? creditReceived / maxLoss : 0;

  // Probability of profit: P(BE_low < S_T < BE_high)
  // = P(S_T > BE_low) + P(S_T < BE_high) - 1
  // Using skew-adjusted σ for each tail
  const probabilityOfProfit = calcPoP(spotPrice, breakEvenLow, breakEvenHigh, row.putSigma, row.callSigma, T);

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
