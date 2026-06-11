/**
 * GET /api/history?date=2026-03-10
 *
 * Returns all 5-minute candles for SPX, VIX, VIX1D, VIX9D, and VVIX
 * for a given trading day. Designed for backtesting: fetch once per date,
 * navigate time on the client.
 *
 * All five symbols are fetched in parallel from Schwab's priceHistory API.
 *
 * Owner-or-guest (uses Schwab credentials).
 *
 * Cache strategy:
 *   - Past dates: cached in Redis for 90 days (data never changes)
 *   - Today: cached 120s (data is still accumulating)
 */

import { Sentry, metrics } from './_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  schwabFetch,
  setCacheHeaders,
  guardOwnerOrGuestEndpoint,
} from './_lib/api-helpers.js';
import { redis } from './_lib/redis.js';
import { getETTotalMinutes, getETDateStr } from '../src/utils/timezone.js';
import logger from './_lib/logger.js';

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
  candles: SchwabCandle[];
  previousClose: number;
}

interface ProcessedCandle {
  datetime: number;
  time: string;
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

interface SymbolDayData {
  candles: ProcessedCandle[];
  previousClose: number;
  previousDay: DaySummary | null;
}

/**
 * Internal fetch result: SymbolDayData plus an `ok` flag indicating whether the
 * Schwab fetch succeeded. A failed fetch returns empty data with `ok: false`,
 * which gates the long-TTL cache write so a transient per-symbol failure is not
 * cached for 90 days.
 */
interface SymbolFetchResult extends SymbolDayData {
  ok: boolean;
}

interface HistoryResponse {
  date: string;
  spx: SymbolDayData;
  vix: SymbolDayData;
  vix1d: SymbolDayData;
  vix9d: SymbolDayData;
  vvix: SymbolDayData;
  candleCount: number;
  asOf: string;
}

// ============================================================
// HELPERS
// ============================================================

const REDIS_PREFIX = 'history:v2:';
const PAST_CACHE_TTL = 90 * 24 * 60 * 60;

function formatTimeET(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function getETDate(ms: number): string {
  return getETDateStr(new Date(ms));
}

function isRegularHours(ms: number): boolean {
  const totalMin = getETTotalMinutes(new Date(ms));
  return totalMin >= 570 && totalMin < 960; // 9:30 AM to 4:00 PM
}

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

/**
 * Fetch priceHistory for a single symbol and extract the target date + previous day.
 */
async function fetchSymbolHistory(
  symbol: string,
  startMs: number,
  endMs: number,
  targetDate: string,
): Promise<SymbolFetchResult> {
  const empty: SymbolFetchResult = {
    candles: [],
    previousClose: 0,
    previousDay: null,
    ok: false,
  };

  const params = new URLSearchParams({
    symbol,
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

  if (!result.ok) {
    logger.error({ symbol, error: result.error }, 'History fetch failed');
    Sentry.addBreadcrumb({
      category: 'history',
      level: 'warning',
      message: 'History symbol fetch failed',
      data: { symbol, targetDate, error: result.error },
    });
    Sentry.captureMessage(`history: ${symbol} fetch failed`, {
      level: 'warning',
    });
    return empty;
  }

  const { candles: allCandles, previousClose } = result.data;

  // Group candles by ET date, filtering to regular hours only
  const byDate = new Map<string, SchwabCandle[]>();
  for (const c of allCandles) {
    if (!isRegularHours(c.datetime)) continue;
    const d = getETDate(c.datetime);
    const arr = byDate.get(d) ?? [];
    arr.push(c);
    byDate.set(d, arr);
  }

  // Get target date candles
  const targetCandles = byDate.get(targetDate) ?? [];

  // Get previous trading day
  const sortedDates = [...byDate.keys()].sort((a, b) => a.localeCompare(b));
  const targetIdx = sortedDates.indexOf(targetDate);
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

  return { candles: processed, previousClose, previousDay, ok: true };
}

// ============================================================
// HANDLER
// ============================================================

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/history');
    const done = metrics.request('/api/history');
    try {
      if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

      const dateParam =
        typeof req.query?.date === 'string' ? req.query.date : '';
      if (!dateParam || !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
        done({ status: 400 });
        return res.status(400).json({
          error: 'Missing or invalid date parameter. Use ?date=YYYY-MM-DD',
        });
      }

      const now = new Date();
      const todayET = getETDateStr(now);
      const isToday = dateParam === todayET;

      if (dateParam > todayET) {
        done({ status: 400 });
        return res
          .status(400)
          .json({ error: 'Cannot fetch history for future dates' });
      }

      // Try Redis cache (past dates are cached long-term)
      const cacheKey = `${REDIS_PREFIX}${dateParam}`;
      if (!isToday) {
        try {
          const cached = await redis.get<HistoryResponse>(cacheKey);
          if (cached) {
            metrics.cacheResult('/api/history', true);
            res.setHeader(
              'Cache-Control',
              's-maxage=86400, stale-while-revalidate=3600',
            );
            res.setHeader('X-Cache', 'HIT');
            done({ status: 200 });
            return res.status(200).json(cached);
          }
        } catch {
          // Redis unavailable
        }
      }

      // Time window: 7 days before to 2 days after target date
      const targetMs = new Date(dateParam + 'T12:00:00Z').getTime();
      const startMs = targetMs - 7 * 24 * 60 * 60 * 1000;
      const endMs = targetMs + 2 * 24 * 60 * 60 * 1000;

      // Fetch all 5 symbols in parallel
      const [spx, vix, vix1d, vix9d, vvix] = await Promise.all([
        fetchSymbolHistory('$SPX', startMs, endMs, dateParam),
        fetchSymbolHistory('$VIX', startMs, endMs, dateParam),
        fetchSymbolHistory('$VIX1D', startMs, endMs, dateParam),
        fetchSymbolHistory('$VIX9D', startMs, endMs, dateParam),
        fetchSymbolHistory('$VVIX', startMs, endMs, dateParam),
      ]);

      // A partially-failed fetch (e.g. $VIX1D times out while $SPX succeeds)
      // must NOT be cached for 90 days — it would serve permanently-empty VIX
      // panels for that date forever. Only the long-TTL write requires every
      // symbol to have succeeded; a partial result falls back to the short TTL
      // so the next request re-fetches and self-heals.
      const allOk = [spx, vix, vix1d, vix9d, vvix].every((s) => s.ok);

      // Strip the internal `ok` flag so it never leaks into the cached payload
      // or the JSON response (HistoryResponse intentionally omits it).
      const toDayData = ({
        candles,
        previousClose,
        previousDay,
      }: SymbolFetchResult): SymbolDayData => ({
        candles,
        previousClose,
        previousDay,
      });

      const response: HistoryResponse = {
        date: dateParam,
        spx: toDayData(spx),
        vix: toDayData(vix),
        vix1d: toDayData(vix1d),
        vix9d: toDayData(vix9d),
        vvix: toDayData(vvix),
        candleCount: spx.candles.length,
        asOf: new Date().toISOString(),
      };

      // Cache
      try {
        if (isToday) {
          await redis.set(cacheKey, response, { ex: 120 });
        } else if (allOk && spx.candles.length > 0) {
          await redis.set(cacheKey, response, { ex: PAST_CACHE_TTL });
        } else if (spx.candles.length > 0) {
          // Past date but at least one symbol failed: short TTL so the empty
          // panels don't persist for 90 days. Observable via the per-symbol
          // captureMessage above.
          await redis.set(cacheKey, response, { ex: 120 });
        }
      } catch (err) {
        logger.error({ err }, 'Failed to cache history');
      }

      // Only a complete past-date response earns the long CDN max-age. Today's
      // data is still accumulating, and a partial-failure response must not be
      // edge-cached for a day (it mirrors the short Redis TTL above).
      const longLived = !isToday && allOk;
      setCacheHeaders(res, longLived ? 86400 : 120, longLived ? 3600 : 60);

      done({ status: 200 });
      res.status(200).json(response);
    } catch (error) {
      done({ status: 500, error: 'unhandled' });
      Sentry.captureException(error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
