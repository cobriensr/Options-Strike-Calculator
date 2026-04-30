/**
 * Shared types for the WhaleAnomalies UI.
 * Mirror of the API response from /api/whale-anomalies.
 */

export const WHALE_TICKERS = [
  'SPX',
  'SPXW',
  'NDX',
  'NDXP',
  'QQQ',
  'SPY',
  'IWM',
] as const;
export type WhaleTicker = (typeof WHALE_TICKERS)[number];

export interface WhaleAnomaly {
  id: number;
  ticker: string;
  option_chain: string;
  strike: number;
  option_type: 'call' | 'put';
  expiry: string;
  first_ts: string;
  last_ts: string;
  detected_at: string;
  side: 'ASK' | 'BID';
  ask_pct: number | null;
  total_premium: number;
  trade_count: number;
  vol_oi_ratio: number | null;
  underlying_price: number | null;
  moneyness: number | null;
  dte: number;
  whale_type: 1 | 2 | 3 | 4;
  direction: 'bullish' | 'bearish';
  pairing_status: 'alone' | 'sequential';
  source: 'live' | 'eod_backfill';
  resolved_at: string | null;
  hit_target: boolean | null;
  pct_to_target: number | null;
}

export interface WhaleAnomaliesResponse {
  date: string;
  asOf: string | null;
  whales: WhaleAnomaly[];
}

export const WHALE_TYPE_LABELS: Record<1 | 2 | 3 | 4, string> = {
  1: 'Floor',
  2: 'Ceiling',
  3: 'Floor break',
  4: 'Ceiling break',
};

export const WHALE_TYPE_DESCRIPTIONS: Record<1 | 2 | 3 | 4, string> = {
  1: 'Floor declared (BID put — strongly bullish)',
  2: 'Ceiling declared (BID call — strongly bearish)',
  3: 'Floor break expected (ASK put — bearish)',
  4: 'Ceiling break expected (ASK call — bullish)',
};
