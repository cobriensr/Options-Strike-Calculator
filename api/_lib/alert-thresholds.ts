/**
 * Alert detection thresholds for the real-time market monitors.
 *
 * These are hardcoded constants — tune after observing real data
 * and redeploy. Kept separate from alert logic for easy adjustment.
 */

export const ALERT_THRESHOLDS = {
  /** IV jump threshold in annualized vol (0.03 = 3 vol points) */
  IV_JUMP_MIN: 0.03,
  /** Max SPX price change (points) for IV spike to qualify */
  IV_PRICE_MAX_MOVE: 5,
  /** Lookback window for IV comparison (minutes) */
  IV_LOOKBACK_MINUTES: 5,
  /** Minimum |delta| in put/call ratio to fire alert */
  RATIO_DELTA_MIN: 0.4,
  /** Lookback window for ratio comparison (minutes) */
  RATIO_LOOKBACK_MINUTES: 5,
  /** Suppress duplicate alerts of same type within this window (minutes) */
  COOLDOWN_MINUTES: 5,
  /** Window for combined alert: both IV spike + ratio surge within this window (minutes) */
  COMBINED_WINDOW_MINUTES: 30,
  /** Minimum severity to trigger SMS notification */
  SMS_MIN_SEVERITY: 'warning' as const,
} as const;
