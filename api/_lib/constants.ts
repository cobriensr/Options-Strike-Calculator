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
