/**
 * Single source of truth for the 16-ticker display order shared
 * across Gexbot grid/chart components (ConvexityMatrix, Skew
 * Dashboard, etc.). Mirrors the GEXBOT_TICKERS const in
 * api/_lib/gexbot-client.ts which drives what the capture crons
 * actually fetch.
 *
 * Keep this list in sync with the backend GEXBOT_TICKERS — any
 * additions on the cron side need a corresponding update here so
 * the grid layout adds the new ticker rather than dropping it.
 */

export const GEXBOT_TICKER_ORDER = [
  // Indexes
  'SPX',
  'ES_SPX',
  'NDX',
  'NQ_NDX',
  'RUT',
  'VIX',
  // ETFs
  'SPY',
  'QQQ',
  'IWM',
  'TLT',
  'GLD',
  'USO',
  'TQQQ',
  'UVXY',
  'HYG',
  'SLV',
] as const;

export type GexbotTicker = (typeof GEXBOT_TICKER_ORDER)[number];
