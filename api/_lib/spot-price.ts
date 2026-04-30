/**
 * Lightweight spot-price fetcher for UW-supported tickers.
 *
 * Used by detect-whales as a fallback when whale_alerts.underlying_price
 * is null (most common for NDX/NDXP — UW occasionally returns null spot
 * on cash indices). Hits UW's /stock/{ticker}/ohlc/1m endpoint and uses
 * the most recent candle's close as the live spot.
 *
 * In-process memoized for 1 minute per ticker — detect-whales fires
 * every minute, so multiple candidates for the same ticker on the same
 * cron tick don't multiply UW calls.
 */

import { uwFetch } from './api-helpers.js';

interface OhlcCandle {
  close: string | number;
  end_time?: string | null;
  start_time?: string | null;
  market_time?: string | null;
}

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  spot: number;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Reset the in-process cache. Test-only. */
export function _resetSpotCache(): void {
  cache.clear();
}

/**
 * Returns the most recent close from /stock/{ticker}/ohlc/1m, or null on
 * any failure. Caller MUST tolerate null — the cron should fall back to
 * the candidate's stored underlying_price (which may itself be null).
 */
export async function getSpotPrice(
  ticker: string,
  apiKey: string,
): Promise<number | null> {
  if (!apiKey) return null;

  const cached = cache.get(ticker);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.spot;
  }

  try {
    const today = new Date().toISOString().slice(0, 10);
    const candles = await uwFetch<OhlcCandle>(
      apiKey,
      `/stock/${ticker}/ohlc/1m?date=${today}`,
    );
    const latest = candles.at(-1);
    if (!latest) return null;
    const spot = Number(latest.close);
    if (!Number.isFinite(spot) || spot <= 0) return null;
    cache.set(ticker, { spot, expiresAt: Date.now() + CACHE_TTL_MS });
    return spot;
  } catch {
    return null;
  }
}
