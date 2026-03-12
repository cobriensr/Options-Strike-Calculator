/**
 * GET /api/history?date=2026-03-10
 *
 * Returns all 5-minute SPX candles for a given trading day, plus the
 * previous day's OHLC for clustering analysis. Designed for backtesting:
 * fetch once per date, navigate time on the client.
 *
 * Owner-gated (uses Schwab credentials).
 *
 * Cache strategy:
 *   - Past dates: cached in Redis indefinitely (data never changes)
 *   - Today: cached 120s (data is still accumulating)
 *   - Edge cache: same logic
 *
 * Response:
 * {
 *   date: "2026-03-10",
 *   candles: [{ datetime, open, high, low, close, time }],
 *   previousClose: 6946.13,
 *   previousDay: { date, open, high, low, close, rangePct, rangePts },
 *   marketClose: "4:00 PM",   // or "1:00 PM" for half days
 *   asOf: ISO string
 * }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  schwabFetch,
  setCacheHeaders,
  rejectIfNotOwner,
} from './_lib/api-helpers.js';
import { redis } from './_lib/schwab.js';

// ============================================================
// TYPES
// ============================================================

interface SchwabCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  datetime: number; // Unix ms
}

interface SchwabPriceHistory {
  symbol: string;
  candles: SchwabCandle[];
  previousClose: number;
}

interface ProcessedCandle {
  datetime: number; // Unix ms
  time: string; // "9:30 AM", "10:05 AM", etc.
  open: number;
  high: number;
  low: number;
  close: number;
}

interface DaySummary {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  rangePct: number;
  rangePts: number;
}

interface HistoryResponse {
  date: string;
  candles: ProcessedCandle[];
  previousClose: number;
  previousDay: DaySummary | null;
  candleCount: number;
  asOf: string;
}

// ============================================================
// HELPERS
// ============================================================

const REDIS_PREFIX = 'history:';
const PAST_CACHE_TTL = 90 * 24 * 60 * 60; // 90 days for past dates

/**
 * Convert a Unix ms timestamp to a human-readable ET time string.
 */
function formatTimeET(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Get the ET date string from a Unix ms timestamp.
 */
function getETDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  });
}

/**
 * Check if a candle falls within regular market hours (9:30 AM - 4:00 PM ET).
 */
function isRegularHours(ms: number): boolean {
  const d = new Date(ms);
  const etStr = d.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const etDate = new Date(etStr);
  const totalMin = etDate.getHours() * 60 + etDate.getMinutes();
  return totalMin >= 570 && totalMin < 960; // 9:30 AM to 4:00 PM
}

/**
 * Compute OHLC summary for a set of candles.
 */
function computeOHLC(
  candles: SchwabCandle[],
  refDate: string,
): DaySummary | null {
  if (candles.length === 0) return null;

  const open = candles[0]!.open;
  const close = candles.at(-1)!.close;
  let high = -Infinity;
  let low = Infinity;

  for (const c of candles) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }

  const rangePts = high - low;
  const rangePct = open > 0 ? (rangePts / open) * 100 : 0;

  return {
    date: refDate,
    open,
    high,
    low,
    close,
    rangePct: Math.round(rangePct * 100) / 100,
    rangePts: Math.round(rangePts * 100) / 100,
  };
}

// ============================================================
// HANDLER
// ============================================================

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (rejectIfNotOwner(req, res)) return;

  const dateParam = typeof req.query?.date === 'string' ? req.query.date : '';
  if (!dateParam || !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return res.status(400).json({
      error: 'Missing or invalid date parameter. Use ?date=YYYY-MM-DD',
    });
  }

  // Check if this is today or a past date
  const now = new Date();
  const todayET = now.toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  });
  const isToday = dateParam === todayET;
  const isFuture = dateParam > todayET;

  if (isFuture) {
    return res
      .status(400)
      .json({ error: 'Cannot fetch history for future dates' });
  }

  // Try Redis cache (past dates are cached indefinitely)
  const cacheKey = `${REDIS_PREFIX}${dateParam}`;
  if (!isToday) {
    try {
      const cached = await redis.get<HistoryResponse>(cacheKey);
      if (cached) {
        res.setHeader(
          'Cache-Control',
          's-maxage=86400, stale-while-revalidate=3600',
        );
        res.setHeader('X-Cache', 'HIT');
        return res.status(200).json(cached);
      }
    } catch {
      // Redis unavailable — fetch fresh
    }
  }

  // Fetch 5-min candles for the target date + a few surrounding days.
  // We request a 10-day window and filter to the specific date.
  // This also gives us the previous trading day for clustering.
  const targetMs = new Date(dateParam + 'T12:00:00Z').getTime();
  const startMs = targetMs - 7 * 24 * 60 * 60 * 1000; // 7 days before
  const endMs = targetMs + 2 * 24 * 60 * 60 * 1000; // 2 days after (covers the full day)

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

  const { candles: allCandles, previousClose } = result.data;

  // Group candles by ET date
  const byDate = new Map<string, SchwabCandle[]>();
  for (const c of allCandles) {
    if (!isRegularHours(c.datetime)) continue;
    const d = getETDate(c.datetime);
    const arr = byDate.get(d) ?? [];
    arr.push(c);
    byDate.set(d, arr);
  }

  // Get target date candles
  const targetCandles = byDate.get(dateParam) ?? [];

  // Get previous trading day (the last date before our target)
  const sortedDates = [...byDate.keys()].sort((a, b) => a.localeCompare(b));
  const targetIdx = sortedDates.indexOf(dateParam);
  const prevDate = targetIdx > 0 ? sortedDates[targetIdx - 1]! : null;
  const prevCandles = prevDate ? (byDate.get(prevDate) ?? []) : [];
  const previousDay = prevDate ? computeOHLC(prevCandles, prevDate) : null;

  // Process target candles
  const processed: ProcessedCandle[] = targetCandles.map((c) => ({
    datetime: c.datetime,
    time: formatTimeET(c.datetime),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  }));

  const response: HistoryResponse = {
    date: dateParam,
    candles: processed,
    previousClose,
    previousDay,
    candleCount: processed.length,
    asOf: new Date().toISOString(),
  };

  // Cache in Redis
  try {
    if (isToday) {
      // Today's data is still accumulating — short TTL
      await redis.set(cacheKey, response, { ex: 120 });
    } else if (processed.length > 0) {
      // Past dates with data — cache for a long time
      await redis.set(cacheKey, response, { ex: PAST_CACHE_TTL });
    }
    // Don't cache empty responses (weekends, holidays)
  } catch (err) {
    console.error('Failed to cache history:', err);
  }

  // Edge cache
  setCacheHeaders(
    res,
    isToday ? 120 : 86400, // 2 min for today, 1 day for past
    isToday ? 60 : 3600,
  );

  res.status(200).json(response);
}
