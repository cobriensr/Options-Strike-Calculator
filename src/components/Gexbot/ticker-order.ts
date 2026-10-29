/**
 * Single source of truth for the 16-ticker capture order shared
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

/**
 * ES_SPX and NQ_NDX are SPX and NDX re-scaled to front-month futures; the
 * vendor reports identical values for them (92.8% identical maxchange).
 * Counting them next to SPX and NDX double-weights those two underlyings.
 */
export const GEXBOT_FUTURES_VIEWS = ['ES_SPX', 'NQ_NDX'] as const;

/**
 * The 14 distinct underlyings, in display order: GEXBOT_TICKER_ORDER minus
 * the futures views. Grids and breadth counts use this by default; a view
 * that wants the futures rows too must opt in by using GEXBOT_TICKER_ORDER.
 */
export const GEXBOT_UNDERLYING_ORDER: readonly GexbotTicker[] =
  GEXBOT_TICKER_ORDER.filter(
    (t) => !(GEXBOT_FUTURES_VIEWS as readonly string[]).includes(t),
  );
