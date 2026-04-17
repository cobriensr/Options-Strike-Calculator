import { MARKET, DEFAULTS } from '../constants/index.js';

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
  // put delta = |N(d1) - 1| = 1 - N(d1), returned as absolute value
  return 1 - normalCDF(d1);
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
 * Black-Scholes vega for a European option.
 * r is assumed 0 for 0DTE.
 *
 * Vega = S × N'(d1) × √T
 *
 * Returns vega per 1.0 change in σ (multiply by 0.01 for per-1%-vol-point).
 * Vega is the same for both puts and calls.
 */
export function calcBSVega(
  spot: number,
  strike: number,
  sigma: number,
  T: number,
): number {
  if (T <= 0 || sigma <= 0 || strike <= 0 || spot <= 0) return 0;

  const sqrtT = Math.sqrt(T);
  const sigmaRootT = sigma * sqrtT;
  const d1 = (Math.log(spot / strike) + ((sigma * sigma) / 2) * T) / sigmaRootT;

  return spot * normalPDF(d1) * sqrtT;
}

/**
 * Black-Scholes theta for a European option.
 * r is assumed 0 for 0DTE.
 *
 * Theta = -[S × N'(d1) × σ] / (2 × √T)
 *
 * For r=0 put and call theta are identical.
 * Returns theta per year; divide by 252 for daily, or by (252×6.5) for per-hour.
 * Returned as negative (time decay costs the option holder).
 */
export function calcBSTheta(
  spot: number,
  strike: number,
  sigma: number,
  T: number,
): number {
  if (T <= 0 || sigma <= 0 || strike <= 0 || spot <= 0) return 0;

  const sqrtT = Math.sqrt(T);
  const sigmaRootT = sigma * sqrtT;
  const d1 = (Math.log(spot / strike) + ((sigma * sigma) / 2) * T) / sigmaRootT;

  // Theta per year (negative value = time decay)
  return -(spot * normalPDF(d1) * sigma) / (2 * sqrtT);
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
