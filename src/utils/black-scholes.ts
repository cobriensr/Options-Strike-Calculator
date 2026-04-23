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
 * Invert a Black-Scholes European option price to the implied volatility σ
 * that would reproduce it under the model.
 *
 * Uses Newton-Raphson on vega with a bisection fallback for safety. r is
 * assumed 0 (consistent with the other functions in this module — valid for
 * 0DTE and a reasonable approximation for the near-dated expiries the IV
 * anomaly detector watches).
 *
 * Returns null when the price is outside the model's feasible range:
 *   - below intrinsic value (arbitrage — quote is stale/broken)
 *   - at or above the undiscounted upper bound (spot for a call, strike for a
 *     put with r=0)
 *   - iteration fails to converge (extreme cases, e.g. price very close to
 *     intrinsic → vega → 0 → Newton explodes)
 *
 * Callers MUST null-check the return value and skip strikes that fail to
 * invert — do not substitute a fallback IV, since that would pollute the
 * time series the anomaly detector is reading.
 */
export function impliedVolatility(
  price: number,
  spot: number,
  strike: number,
  T: number,
  type: 'call' | 'put',
  opts: {
    /** Convergence tolerance in price units. Default 1e-6. */
    tol?: number;
    /** Maximum Newton iterations before falling through to bisection. Default 50. */
    maxIter?: number;
    /** Lower bound of the bisection bracket. Default 1e-6 (0.0001%). */
    sigmaMin?: number;
    /** Upper bound of the bisection bracket. Default 5 (500% vol). */
    sigmaMax?: number;
  } = {},
): number | null {
  const { tol = 1e-6, maxIter = 50, sigmaMin = 1e-6, sigmaMax = 5 } = opts;

  if (
    !Number.isFinite(price) ||
    !Number.isFinite(spot) ||
    !Number.isFinite(strike) ||
    !Number.isFinite(T) ||
    spot <= 0 ||
    strike <= 0 ||
    T <= 0 ||
    price <= 0
  ) {
    return null;
  }

  // Reject prices outside the feasible range. For r=0:
  //   call:  intrinsic = max(spot - strike, 0), upper bound = spot
  //   put:   intrinsic = max(strike - spot, 0), upper bound = strike
  const intrinsic =
    type === 'call' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  const upperBound = type === 'call' ? spot : strike;
  if (price < intrinsic - tol) return null;
  if (price >= upperBound - tol) return null;

  // Newton-Raphson from a Manaster-Koehler-style initial guess.
  // σ₀ ≈ √(2 / T) × |ln(S/K)| is a solid starting point for near-ATM strikes;
  // for far-OTM we bump it to 0.5 to avoid vega ≈ 0 at σ ≈ 0.
  const logMoneyness = Math.abs(Math.log(spot / strike));
  let sigma = Math.max(Math.sqrt((2 * logMoneyness) / T), 0.3);
  if (!Number.isFinite(sigma) || sigma <= 0) sigma = 0.5;

  for (let i = 0; i < maxIter; i += 1) {
    const modelPrice = blackScholesPrice(spot, strike, sigma, T, type);
    const diff = modelPrice - price;
    if (Math.abs(diff) < tol) {
      if (sigma < sigmaMin || sigma > sigmaMax) break;
      return sigma;
    }
    const vega = calcBSVega(spot, strike, sigma, T);
    // If vega collapses we're at the tails of the model; fall through to
    // bisection rather than taking huge Newton steps.
    if (!Number.isFinite(vega) || vega < 1e-8) break;
    const next = sigma - diff / vega;
    // Clamp into the search bracket so Newton can't walk into negative-σ
    // territory or diverge off to infinity.
    if (!Number.isFinite(next) || next <= sigmaMin || next >= sigmaMax) break;
    sigma = next;
  }

  // Bisection fallback. Guarantees convergence whenever the price is inside
  // the feasible range, at the cost of ~40 iterations worst case.
  let lo = sigmaMin;
  let hi = sigmaMax;
  const loPrice = blackScholesPrice(spot, strike, lo, T, type);
  const hiPrice = blackScholesPrice(spot, strike, hi, T, type);
  // Monotonic in σ: price(σ) strictly increases from intrinsic → upperBound.
  if (price < loPrice || price > hiPrice) return null;

  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    const midPrice = blackScholesPrice(spot, strike, mid, T, type);
    if (Math.abs(midPrice - price) < tol) return mid;
    if (midPrice < price) lo = mid;
    else hi = mid;
    if (hi - lo < tol) return (lo + hi) / 2;
  }

  return null;
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
