import type { DeltaTarget, HedgeDelta } from '../types';

/** Market hours and trading calendar constants */
export const MARKET = {
  /** Regular trading hours per day (9:30 AM - 4:00 PM ET) */
  HOURS_PER_DAY: 6.5,
  /** Standard US equity trading days per year */
  TRADING_DAYS_PER_YEAR: 252,
  /**
   * Calendar days per year. Used for annualizing T over a holding period
   * that spans overnights (e.g. multi-day hedges held across calendar days,
   * not just trading days). Intraday 0DTE theta still uses TRADING_DAYS_PER_YEAR.
   * See audit FE-MATH-008.
   */
  CALENDAR_DAYS_PER_YEAR: 365,
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

/** SPX contract multiplier (each point = $100) */
export const SPX_MULTIPLIER = 100;

/** Default SPX-to-SPY price ratio */
export const DEFAULT_SPX_SPY_RATIO = 10;

/** IV stress model parameters for hedge repricing */
export const STRESS = {
  /** IV sensitivity to SPX declines (VIX pts per 1% SPX drop) */
  CRASH_SENSITIVITY: 4,
  /** IV sensitivity to SPX rallies (VIX pts per 1% SPX rise) */
  RALLY_SENSITIVITY: 1.5,
  /** Maximum stressed sigma multiplier (cap) */
  MAX_MULT: 3,
  /** Hedge breakeven target as multiple of spot-to-hedge distance */
  BREAKEVEN_TARGET: 1.5,
} as const;

/** Default values and configurable limits */
export const DEFAULTS = {
  /** Default 0DTE IV premium multiplier over VIX */
  IV_PREMIUM_FACTOR: 1.15,
  /** Minimum allowed IV premium multiplier */
  IV_PREMIUM_MIN: 1,
  /** Maximum allowed IV premium multiplier (raised for event days: FOMC, CPI) */
  IV_PREMIUM_MAX: 2,
  /** Risk-free rate (negligible for 0DTE) */
  RISK_FREE_RATE: 0,
  /** SPX strike increment for snapping */
  STRIKE_INCREMENT: 5,
  /**
   * Reference z-score for skew scaling (10Δ = 1.28).
   * Skew is specified at this delta and scaled for other deltas.
   */
  SKEW_REFERENCE_Z: DELTA_Z_SCORES[10],
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
   * Default fat-tail kurtosis factors for PoP adjustment.
   * Use getKurtosisFactor(vix) for regime-dependent values.
   *
   * SPX has negative skew: crashes are sharper than rallies.
   * crash (put side) gets a higher multiplier than rally (call side).
   *
   * The adjustment is applied per-tail as:
   *   P_adjusted(put breach) = min(1, P_lognormal(put breach) × crash)
   *   P_adjusted(call breach) = min(1, P_lognormal(call breach) × rally)
   */
  KURTOSIS_FACTOR: { crash: 2.5, rally: 1.5 },
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
  /**
   * Down-day cluster: both sides expand (V-reversal risk).
   * Post-2020 behavior: gap-down followed by reversal rally means
   * BOTH put and call wings are at risk. Put side still gets more weight.
   */
  CLUSTER_DOWN_PUT_WEIGHT: 1.3,
  CLUSTER_DOWN_CALL_WEIGHT: 1.1,
  /**
   * Up-day cluster: momentum compresses put-side more aggressively.
   * Rally days have strong put compression, mild call expansion.
   */
  CLUSTER_UP_PUT_WEIGHT: 0.6,
  CLUSTER_UP_CALL_WEIGHT: 1.3,

  /** VIX1D/VIX ratio thresholds for term structure classification */
  VIX1D_RATIO_CALM: 0.75,
  VIX1D_RATIO_NORMAL: 1,
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

export interface KurtosisPair {
  crash: number;
  rally: number;
}

/**
 * VIX-regime-dependent kurtosis factors for fat-tail PoP adjustment.
 *
 * SPX has negative return skew: crashes are sharper than rallies.
 * Each regime returns asymmetric factors — crash (put side) is higher.
 *
 * Calibrated from 9,102 matched trading days (1990–2026):
 *   VIX <15:  Low vol  — crash 1.8×, rally 1.2×
 *   VIX 15–20: Moderate — crash 2.5×, rally 1.5×
 *   VIX 20–25: Elevated — crash 3.0×, rally 2.0×
 *   VIX 25–30: High vol — crash 3.5×, rally 2.5×
 *   VIX 30+:   Crisis   — crash 4.0×, rally 3.0×
 *
 * Returns the default KURTOSIS_FACTOR when VIX is unavailable.
 */
export function getKurtosisFactor(vix?: number): KurtosisPair {
  if (vix == null || vix <= 0) return DEFAULTS.KURTOSIS_FACTOR;
  if (vix < 15) return { crash: 1.8, rally: 1.2 };
  if (vix < 20) return { crash: 2.5, rally: 1.5 };
  if (vix < 25) return { crash: 3, rally: 2 };
  if (vix < 30) return { crash: 3.5, rally: 2.5 };
  return { crash: 4, rally: 3 };
}

/** Wing width options for iron condor spreads (SPX points) */
export const WING_OPTIONS = [5, 10, 15, 20, 25, 30, 50] as const;

/** Narrow wing width options for BWB (SPX points) */
export const BWB_NARROW_OPTIONS = [10, 15, 20, 25, 30] as const;

/** Wide wing multiplier options for BWB (wide = narrow × multiplier) */
export const BWB_WIDE_MULTIPLIERS = [1.5, 2, 2.5, 3] as const;

/** Risk tier percentages for position sizing table */
export const RISK_TIERS = [1, 2, 3, 5, 10] as const;

/** Target delta values for settlement check analysis */
export const SETTLEMENT_DELTAS = [5, 8, 10, 12, 15] as const;

/**
 * Trader's preferred entry delta for credit spreads (|delta|).
 * Used to anchor the Chain Delta Rungs context passed to the analyze endpoint
 * so Claude can map the target delta to an actual market strike.
 */
export const PREFERRED_ENTRY_DELTA = 12;

/**
 * Absolute floor on short-strike |delta| for credit spreads (both sides of an
 * IC). Below this floor the credit received does not justify the tail risk —
 * if the structurally correct trade cannot reach the floor, SIT OUT.
 */
export const FLOOR_ENTRY_DELTA = 10;

/**
 * Delta rungs (|delta|, as integer percent) sampled from the live option chain
 * and passed to Claude. Narrow enough to avoid token bloat, dense enough
 * around the 10-15Δ target zone for precise strike picks.
 */
export const CHAIN_DELTA_RUNGS = [5, 8, 10, 12, 15, 20, 25] as const;

/** IV input mode identifiers */
export const IV_MODES = {
  VIX: 'vix',
  DIRECT: 'direct',
} as const;

/**
 * Silence window for Strike IV anomaly aggregation.
 *
 * A compound-key anomaly (ticker:strike:side:expiry) that stops firing for
 * this long is evicted from the active board. The NEXT firing for that key
 * is treated as a brand-new event and re-triggers the banner + chime.
 *
 * 15 min balances "the event is genuinely over" against "same strike
 * coming back after a brief pause is still the same event."
 */
export const ANOMALY_SILENCE_MS = 15 * 60 * 1000;

/** Polling intervals for data fetching hooks (milliseconds) */
export const POLL_INTERVALS = {
  /** Live quote refresh (useAutoFill, useMarketData) */
  QUOTES: 10_000,
  /** Option chain refresh (useChainData) */
  CHAIN: 60_000,
  /** Market data refresh (useMarketData) */
  MARKET_DATA: 60_000,
  /** History data refresh (useHistoryData) */
  HISTORY: 10_000,
  /** Alert polling interval (useAlertPolling) */
  ALERTS: 10_000,
  /** OTM SPXW flow alerts refresh (useOtmFlowAlerts) — matches fetch-flow-alerts cron cadence */
  OTM_FLOW: 30_000,
  /** Dark pool levels refresh (useDarkPoolLevels) */
  DARK_POOL: 60_000,
  /** GEX per strike refresh (useGexPerStrike) */
  GEX_STRIKE: 60_000,
  /** GexTarget history refresh (useGexTarget) — matches the 1-min cron cadence */
  GEX_TARGET: 60_000,
  /** SPY NOPE intraday refresh (useNopeIntraday) — matches fetch-nope cron */
  NOPE: 60_000,
  /** Market internals refresh ($TICK/$ADD/$VOLD/$TRIN) — matches 1-min cron */
  MARKET_INTERNALS: 60_000,
} as const;

/** Progress messages shown during chart analysis */
export const THINKING_MESSAGES = [
  'Reading chart data...',
  'Fetching open positions...',
  'Analyzing Market Tide flow...',
  'Checking SPX Net Flow...',
  'Checking Net Flow confirmation...',
  'Evaluating gamma exposure...',
  'Checking charm decay profile...',
  'Reading aggregate GEX regime...',
  'Confirming charm with Periscope...',
  'Mapping strikes to gamma zones...',
  'Building entry plan...',
  'Assessing hedge options...',
  'Formulating management rules...',
] as const;
