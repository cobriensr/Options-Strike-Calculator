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
