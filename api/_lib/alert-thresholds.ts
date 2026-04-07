/**
 * Alert detection thresholds for the real-time market monitors.
 *
 * These are hardcoded constants — tune after observing real data
 * and redeploy. Kept separate from alert logic for easy adjustment.
 */

export const ALERT_THRESHOLDS = {
  /** IV jump threshold in annualized vol (0.01 = 1 vol point).
   *  Calibrated 2026-04-07 against raw UW data: on active 40-point
   *  candle sessions the biggest real 5-min IV jump was ~0.8 vol
   *  points. Setting the floor at 1 vol point filters routine drift
   *  while still firing during genuine expansions. The prior 3 vol
   *  point floor (0.03) only fired during shock events (SVB-type)
   *  and was silent on normally volatile 0DTE days. */
  IV_JUMP_MIN: 0.01,
  /** Max SPX price change (points) for IV spike to qualify */
  IV_PRICE_MAX_MOVE: 5,
  /** Lookback window for IV comparison (minutes) */
  IV_LOOKBACK_MINUTES: 5,
  /** Minimum |delta| in put/call ratio to fire alert */
  RATIO_DELTA_MIN: 0.7,
  /** Lookback window for ratio comparison (minutes) */
  RATIO_LOOKBACK_MINUTES: 5,
  /** Minimum premium movement ($) to qualify a ratio surge — filters
   *  low-volume ratio swings that lack institutional conviction.
   *  Calibrated 2026-04-07 against raw /net-flow/expiry?tide_type=
   *  index_only data: 5-min signed deltas on the driver side rarely
   *  exceed $3M even on 40-point candle days because the index_only
   *  filter excludes SPY/SPXW flow. $5M was unreachable; $1M catches
   *  real institutional moves while filtering routine noise. */
  RATIO_PREMIUM_MIN: 1_000_000,
  /** Suppress duplicate alerts of same type within this window (minutes) */
  COOLDOWN_MINUTES: 5,
  /** Window for combined alert: both IV spike + ratio surge within this window (minutes) */
  COMBINED_WINDOW_MINUTES: 30,
  /** Minimum severity to trigger SMS notification */
  SMS_MIN_SEVERITY: 'warning' as const,
} as const;
