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
export const DELTA_OPTIONS: readonly DeltaTarget[] = [5, 8, 10, 12, 15, 20] as const;

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
   * Skew is specified at this delta and scaled proportionally
   * for other deltas: further OTM (higher z) gets more skew,
   * nearer OTM (lower z) gets less skew. This models the
   * real volatility smile where far OTM puts have steeper skew.
   */
  SKEW_REFERENCE_Z: 1.28,
  /** Default hedge delta */
  HEDGE_DELTA: 2 as HedgeDelta,
} as const;

/** IV input mode identifiers */
export const IV_MODES = {
  VIX: 'vix',
  DIRECT: 'direct',
} as const;