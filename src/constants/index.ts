import type { DeltaTarget, HedgeDelta } from '../types';

/** Market hours and trading calendar constants */
export const MARKET = {
  /** Regular trading hours per day (9:30 AM - 4:00 PM ET) */
  HOURS_PER_DAY: 6.5,
  /** Standard US equity trading days per year */
  TRADING_DAYS_PER_YEAR: 252,
  /** Total trading hours per year (6.5 × 252) */
  ANNUAL_TRADING_HOURS: 6.5 * 252, // 1638
  /** Market open hour in Eastern Time (24h) */
  OPEN_HOUR_ET: 9,
  /** Market open minute in Eastern Time */
  OPEN_MINUTE_ET: 30,
  /** Market close hour in Eastern Time (24h) */
  CLOSE_HOUR_ET: 16,
  /** Market close minute in Eastern Time */
  CLOSE_MINUTE_ET: 0,
} as const;

/**
 * Z-scores (inverse normal CDF) for each delta target.
 * For a put with delta D: z = N⁻¹(1 - D/100)
 */
export const DELTA_Z_SCORES: Readonly<Record<DeltaTarget, number>> = {
  5: 1.645,
  8: 1.405,
  10: 1.28,
  12: 1.175,
  15: 1.036,
  20: 0.842,
} as const;

/**
 * Z-scores for hedge delta targets (far OTM protection).
 * 1Δ: N⁻¹(0.99) = 2.326
 * 2Δ: N⁻¹(0.98) = 2.054
 * 3Δ: N⁻¹(0.97) = 1.881
 * 5Δ: N⁻¹(0.95) = 1.645 (same as main 5Δ)
 */
export const HEDGE_Z_SCORES: Readonly<Record<HedgeDelta, number>> = {
  1: 2.326,
  2: 2.054,
  3: 1.881,
  5: 1.645,
} as const;

/** All available delta targets, sorted ascending */
export const DELTA_OPTIONS: readonly DeltaTarget[] = [
  5, 8, 10, 12, 15, 20,
] as const;

/** Available hedge delta options */
export const HEDGE_DELTA_OPTIONS: readonly HedgeDelta[] = [1, 2, 3, 5] as const;

/** Default values and configurable limits */
export const DEFAULTS = {
  /** Default 0DTE IV premium multiplier over VIX */
  IV_PREMIUM_FACTOR: 1.15,
  /** Minimum allowed IV premium multiplier */
  IV_PREMIUM_MIN: 1,
  /** Maximum allowed IV premium multiplier */
  IV_PREMIUM_MAX: 1.3,
  /** Risk-free rate (negligible for 0DTE) */
  RISK_FREE_RATE: 0,
  /** SPX strike increment for snapping */
  STRIKE_INCREMENT: 5,
  /**
   * Reference z-score for skew scaling (10Δ = 1.28).
   * Skew is specified at this delta and scaled for other deltas.
   */
  SKEW_REFERENCE_Z: 1.28,
  /**
   * Convexity exponent for put skew (> 1 = convex = steeper far OTM).
   * Empirically calibrated for SPX: 5Δ puts trade at ~1.35× the linear
   * extrapolation from 10Δ. This makes far-OTM put premiums higher,
   * matching the real volatility smile shape.
   */
  SKEW_PUT_CONVEXITY: 1.35,
  /**
   * Dampening factor for call skew at high z-scores.
   * Real call skew flattens further OTM (and sometimes inverts on rallies).
   * Applied as: call_scaledSkew × (1 / (1 + dampening × (z/z_ref - 1)))
   * At 10Δ (z = z_ref): no dampening. At 5Δ (z = 1.645): ~15% reduction.
   */
  SKEW_CALL_DAMPENING: 0.5,
  /**
   * Intraday IV acceleration coefficients.
   * As the 0DTE session progresses, realized IV tends to increase because
   * gamma acceleration makes delta-hedging more expensive for market makers.
   * This multiplier is applied to σ for pricing and PoP calculations.
   *
   * Model: mult = 1 + ACCEL_COEFF × (1 / hoursRemaining - 1 / HOURS_PER_DAY)
   * At open (6.5h): 1.0x. At 2h: ~1.12x. At 1h: ~1.28x. At 0.5h: ~1.56x.
   * Capped at ACCEL_MAX to prevent extreme values near close.
   */
  IV_ACCEL_COEFF: 0.6,
  IV_ACCEL_MAX: 1.8,
  /**
   * Fat-tail kurtosis factor for PoP adjustment.
   * SPX intraday returns have excess kurtosis ~3-5 (vs 0 for normal).
   * This factor multiplies the breach probability at each tail.
   * Calibrated from 9,102 days: actual 2σ+ breach rate is ~2× log-normal.
   *
   * The adjustment is applied as:
   *   P_adjusted(breach) = min(1, P_lognormal(breach) × KURTOSIS_FACTOR)
   *   PoP_adjusted = 1 - P_adjusted(put breach) - P_adjusted(call breach)
   */
  KURTOSIS_FACTOR: 2.0,
  /** Default hedge delta */
  HEDGE_DELTA: 2 as HedgeDelta,
  /**
   * Default hedge DTE (days to expiration).
   * 7-14 DTE hedges lose minimal theta during a single session
   * and can be sold to close at EOD recovering 70-90% of purchase price.
   * Contrast with 0DTE hedges that lose 80-100% to theta burn.
   */
  HEDGE_DTE: 7,
  /** Minimum hedge DTE */
  HEDGE_DTE_MIN: 1,
  /** Maximum hedge DTE */
  HEDGE_DTE_MAX: 21,
} as const;

/** Trading model parameters for regime classification and signal computation */
export const SIGNALS = {
  /** Minimum absolute daily return to classify as a directional day */
  CLUSTER_DIRECTION_THRESHOLD: 0.003,
  /** Down-day cluster: put-side weight (70% of excess → 1.4×) */
  CLUSTER_DOWN_PUT_WEIGHT: 1.4,
  /** Down-day cluster: call-side weight (30% of excess → 0.6×) */
  CLUSTER_DOWN_CALL_WEIGHT: 0.6,
  /** Up-day cluster: put-side weight (40% of excess → 0.8×) */
  CLUSTER_UP_PUT_WEIGHT: 0.8,
  /** Up-day cluster: call-side weight (60% of excess → 1.2×) */
  CLUSTER_UP_CALL_WEIGHT: 1.2,

  /** VIX1D/VIX ratio thresholds for term structure classification */
  VIX1D_RATIO_CALM: 0.75,
  VIX1D_RATIO_NORMAL: 1.0,
  VIX1D_RATIO_ELEVATED: 1.25,

  /** VIX9D/VIX ratio thresholds (inverted: higher ratio = calmer) */
  VIX9D_RATIO_CALM: 1.1,
  VIX9D_RATIO_NORMAL: 0.95,
  VIX9D_RATIO_ELEVATED: 0.85,

  /** VVIX absolute thresholds */
  VVIX_CALM: 85,
  VVIX_NORMAL: 100,
  VVIX_ELEVATED: 120,

  /** Opening range consumption thresholds (fraction of median H-L) */
  OPENING_RANGE_GREEN: 0.4,
  OPENING_RANGE_MODERATE: 0.65,

  /** Term structure shape threshold (ratio distance from 1.0 for contango/backwardation) */
  TERM_SHAPE_THRESHOLD: 0.03,
  /** Term structure flat threshold (all ratios within ±5% of 1.0) */
  TERM_FLAT_THRESHOLD: 0.05,

  /** RV/IV ratio classification thresholds */
  RVIV_RICH_BELOW: 0.8,
  RVIV_CHEAP_ABOVE: 1.2,
} as const;

/** IV input mode identifiers */
export const IV_MODES = {
  VIX: 'vix',
  DIRECT: 'direct',
} as const;
