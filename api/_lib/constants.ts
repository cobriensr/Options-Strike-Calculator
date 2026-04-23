/**
 * Shared constants for API serverless functions.
 * Centralizes timeouts, market time boundaries, and other magic numbers
 * that were previously scattered across endpoint files.
 */

/** HTTP request timeouts (milliseconds) */
export const TIMEOUTS = {
  /** Schwab API calls */
  SCHWAB_API: 30_000,
  /** Unusual Whales API calls */
  UW_API: 15_000,
  /** Default API call timeout */
  DEFAULT: 10_000,
} as const;

/** Market time boundaries in minutes since midnight (ET) */
export const MARKET_MINUTES = {
  /** 9:30 AM ET = 570 minutes */
  OPEN: 570,
  /** 4:00 PM ET = 960 minutes */
  CLOSE: 960,
} as const;

/** Unusual Whales API base URL */
export const UW_BASE = 'https://api.unusualwhales.com/api';

// ============================================================
// STRIKE IV ANOMALY DETECTOR (Phase 1)
// ============================================================

/**
 * Per-strike IV snapshot filters for the fetch-strike-iv cron.
 * OTM range: ±3% of spot covers 1% (today's 7100→7034 example) through tail hedges.
 * Min OI gates out illiquid strikes whose mid prices are stale — different per
 * ticker because SPX strikes are $5-wide (OI concentrates) vs SPY/QQQ $1-wide
 * (OI disperses across a wider band of strikes).
 */
export const STRIKE_IV_OTM_RANGE_PCT = 0.03;
export const STRIKE_IV_MIN_OI_SPX = 500;
export const STRIKE_IV_MIN_OI_SPY_QQQ = 250;
export const STRIKE_IV_TICKERS = ['SPX', 'SPY', 'QQQ'] as const;
export type StrikeIVTicker = (typeof STRIKE_IV_TICKERS)[number];

// ============================================================
// STRIKE IV ANOMALY DETECTOR (Phase 2 — detection)
// ============================================================

/**
 * Cross-strike skew delta: target strike IV minus avg IV of the 2 neighbors
 * each side (same side, same expiry, same ticker, most recent sample).
 * 1.5 vol points is large enough that common charm/gamma factors don't
 * produce false positives on liquid chains, but small enough to flag the
 * informed-flow ramp pattern at detection time.
 */
export const SKEW_DELTA_THRESHOLD = 1.5;

/**
 * Rolling Z-score: target strike's iv_mid vs its own Z_WINDOW_SIZE-sample
 * history. 2.0σ is the ~97.5th percentile for a normal distribution — rare
 * enough to be informative, frequent enough to get labeled samples for ML.
 */
export const Z_SCORE_THRESHOLD = 2.0;

/**
 * How many prior samples feed the rolling Z. 60 samples at 1-min cadence
 * ≈ 1 trading hour — long enough for σ to stabilize, short enough that
 * regime shifts during the session still propagate.
 */
export const Z_WINDOW_SIZE = 60;

/**
 * Ask-mid IV divergence: iv_ask minus iv_mid. Tracked on every anomaly
 * but NOT a standalone gate per spec — it's a tie-breaker / supporting
 * signal for Claude's retrospective analysis in Phase 4.
 */
export const ASK_MID_DIV_THRESHOLD = 0.5;
