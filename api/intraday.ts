/**
 * GET /api/intraday
 *
 * Returns today's running SPX OHLC and 30-minute opening range,
 * computed from 5-minute intraday candles.
 *
 * Uses Schwab priceHistory: $SPX, period=1 day, 5-min candles.
 *
 * Cache:
 *   Market hours: 120s edge cache + 60s SWR
 *   After hours:  600s edge cache + 120s SWR
 *
 * Response:
 * {
 *   today: { open, high, low, last },
 *   openingRange: { high, low, rangePts, minutes },
 *   previousClose: number,
 *   candleCount: number,
 *   marketOpen: boolean,
 *   asOf: ISO string
 * }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { schwabFetch, setCacheHeaders, isMarketOpen, rejectIfNotOwner } from './_lib/api-helpers.js';

// ============================================================
// TYPES
// ============================================================

interface SchwabCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  datetime: number;
}

interface SchwabPriceHistory {
  symbol: string;
  empty: boolean;
  previousClose: number;
  previousCloseDate: number;
  candles: SchwabCandle[];
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Compute the 30-minute opening range from 5-min candles.
 * First 6 candles = 30 minutes (9:30–10:00 AM ET).
 */
function computeOpeningRange(candles: SchwabCandle[]): {
  high: number;
  low: number;
  rangePts: number;
  minutes: number;
  complete: boolean;
} | null {
  if (candles.length === 0) return null;

  // Take first 6 candles (30 min of 5-min bars)
  const orCandles = candles.slice(0, Math.min(6, candles.length));
  const complete = candles.length >= 6;

  let high = -Infinity;
  let low = Infinity;
  for (const c of orCandles) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }

  return {
    high,
    low,
    rangePts: Math.round((high - low) * 100) / 100,
    minutes: orCandles.length * 5,
    complete,
  };
}

/**
 * Compute today's running OHLC from all candles.
 */
function computeTodayOHLC(candles: SchwabCandle[]): {
  open: number;
  high: number;
  low: number;
  last: number;
} | null {
  if (candles.length === 0) return null;

  const open = candles[0]!.open;
  const last = candles.at(-1)!.close;
  let high = -Infinity;
  let low = Infinity;

  for (const c of candles) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }

  return { open, high, low, last };
}

// ============================================================
// HANDLER
// ============================================================

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Owner-only: public visitors get 401, frontend falls back to manual input
  if (rejectIfNotOwner(req, res)) return;

  // Use explicit start/end dates for TODAY's session.
  // period=1 returns the most recent *completed* day, which during market
  // hours is yesterday. Instead, fetch a 24h window and filter to today's
  // ET date to get the current session's candles.
  const now = new Date();
  const todayET = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  // Fetch a 24h window. Schwab only returns market-hours candles
  // (needExtendedHoursData=false). We filter to today's date below
  // in case the window overlaps yesterday's session.
  const startMs = now.getTime() - 24 * 60 * 60 * 1000;
  const endMs = now.getTime();

  const params = new URLSearchParams({
    symbol: '$SPX',
    periodType: 'day',
    frequencyType: 'minute',
    frequency: '5',
    startDate: String(startMs),
    endDate: String(endMs),
    needExtendedHoursData: 'false',
    needPreviousClose: 'true',
  });

  const result = await schwabFetch<SchwabPriceHistory>(
    `/pricehistory?${params.toString()}`,
  );

  if ('error' in result) {
    return res.status(result.status).json({ error: result.error });
  }

  const { previousClose } = result.data;
  const marketOpen = isMarketOpen();

  // Filter candles to today's ET date AND regular session hours only.
  // $SPX candles can start before 9:30 AM (pre-market indicative values)
  // even with needExtendedHoursData=false. We need the 9:30 AM open to
  // match the actual regular session open shown on TradingView/brokers.
  const todayCandles = result.data.candles.filter((c) => {
    const d = new Date(c.datetime);
    const etStr = d.toLocaleString('en-US', { timeZone: 'America/New_York' });
    const etDate = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (etDate !== todayET) return false;

    // Parse the ET time — only keep candles from 9:30 AM onward
    const etTime = new Date(etStr);
    const hours = etTime.getHours();
    const minutes = etTime.getMinutes();
    const totalMinutes = hours * 60 + minutes;
    return totalMinutes >= 570; // 9:30 AM = 9*60 + 30 = 570
  });

  // Cache: 2 min during hours (opening range doesn't change after 10 AM),
  // 10 min after close (data is final)
  setCacheHeaders(res, marketOpen ? 120 : 600, marketOpen ? 60 : 120);

  const today = computeTodayOHLC(todayCandles);
  const openingRange = computeOpeningRange(todayCandles);

  res.status(200).json({
    today,
    openingRange,
    previousClose,
    candleCount: todayCandles.length,
    marketOpen,
    asOf: new Date().toISOString(),
  });
}