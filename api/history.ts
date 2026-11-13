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
 * Cache strategy (Redis entry TTL; the browser max-age matches on hit and miss):
 *   - Past dates, every symbol fetched: 90 days in Redis, 1 day in the browser
 *   - Past dates with a failed symbol, or today: 120s (self-heals)
 */

import { Sentry, metrics } from './_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  schwabFetch,
  guardOwnerOrGuestEndpoint,
  sendError,
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
  /** The target day's candles repeated a datetime (dropped before returning). */
  hadDuplicates: boolean;
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

/**
 * Redis entry. `complete` (a past date where every symbol fetched) is stored
 * so a hit replays the browser max-age the original response got: a 120 s
 * partial entry must not come back with the day-long one.
 */
interface CachedHistory {
  response: HistoryResponse;
  complete: boolean;
}

// ============================================================
// HELPERS
// ============================================================

// v3 entries are CachedHistory. v2 entries (bare responses) are never read
// again and expire on their own TTL.
const REDIS_PREFIX = 'history:v3:';
const PAST_CACHE_TTL = 90 * 24 * 60 * 60;

/**
 * Browser-only lifetime: a day for a complete past date, else 120 s. Never a
 * shared-cache directive, because the CDN would serve this guarded response
 * without running the guard.
 */
function cacheControlFor(complete: boolean): string {
  return `private, max-age=${complete ? 86400 : 120}`;
}

/** Envelope check only: `response` is an object and `complete` a boolean. */
function isCachedHistory(value: unknown): value is CachedHistory {
  if (typeof value !== 'object' || value === null) return false;
  const { response, complete } = value as Record<string, unknown>;
  return (
    typeof response === 'object' &&
    response !== null &&
    !Array.isArray(response) &&
    typeof complete === 'boolean'
  );
}

const SYMBOL_FIELDS = ['spx', 'vix', 'vix1d', 'vix9d', 'vvix'] as const;

/**
 * Candles in ascending `datetime` order, one per datetime. Of several candles
 * sharing a datetime the first in the input stays (the sort is stable). Schwab
 * has returned a whole session twice end to end (2026-11-11), and the client
 * takes running high/low over candles 0..index of the array, so a doubled
 * array gives every snapshot of the day the full day's range.
 */
function sortUniqueByDatetime<T extends { datetime: number }>(
  candles: readonly T[],
): T[] {
  const sorted = [...candles].sort((a, b) => a.datetime - b.datetime);
  const unique: T[] = [];
  for (const c of sorted) {
    if (unique.at(-1)?.datetime !== c.datetime) unique.push(c);
  }
  return unique;
}

function hasFiniteDatetime(c: unknown): c is { datetime: number } {
  return (
    typeof c === 'object' &&
    c !== null &&
    Number.isFinite((c as { datetime?: unknown }).datetime)
  );
}

/**
 * A stored response with each symbol's candles sorted and unique. A stored
 * entry from before the fetch path deduplicated keeps its doubled candles for
 * the rest of its 90-day TTL, so the repair happens on every read and the
 * stored value is not rewritten. Only the envelope is validated on read, so a
 * symbol whose candles are missing or malformed is passed through as stored,
 * and an entry that needs no repair comes back as the same object. Repairs are
 * logged and not sent to Sentry: a stored entry would report on every hit.
 */
function repairCachedCandles(
  response: HistoryResponse,
  cacheKey: string,
): HistoryResponse {
  const repaired: HistoryResponse = { ...response };
  const repairs: { field: string; rawCount: number; uniqueCount: number }[] =
    [];
  for (const field of SYMBOL_FIELDS) {
    const day = response[field] as SymbolDayData | null | undefined;
    if (!day || !Array.isArray(day.candles)) continue;
    const raw: readonly unknown[] = day.candles;
    if (!raw.every(hasFiniteDatetime)) continue;
    const unique = sortUniqueByDatetime(raw);
    if (unique.length === raw.length && unique.every((c, i) => c === raw[i])) {
      continue;
    }
    repairs.push({
      field,
      rawCount: raw.length,
      uniqueCount: unique.length,
    });
    repaired[field] = { ...day, candles: unique as ProcessedCandle[] };
    if (field === 'spx') repaired.candleCount = unique.length;
  }
  if (repairs.length === 0) return response;
  logger.warn(
    { cacheKey, repaired: repairs },
    'Cached history held duplicate or unordered candles; served normalized',
  );
  return repaired;
}

/**
 * Read a cached entry. A Redis error or a wrong-shaped value is a miss, and
 * the fetch path then overwrites the key, so a bad entry heals on the next
 * request instead of being served until its TTL runs out. A hit comes back
 * with its candles sorted and unique (repairCachedCandles).
 */
async function readCachedHistory(
  cacheKey: string,
): Promise<CachedHistory | null> {
  let cached: unknown;
  try {
    cached = await redis.get<unknown>(cacheKey);
  } catch {
    return null; // Redis unavailable
  }
  if (cached == null) return null;
  if (isCachedHistory(cached)) {
    return {
      response: repairCachedCandles(cached.response, cacheKey),
      complete: cached.complete,
    };
  }
  logger.warn({ cacheKey }, 'Malformed history cache entry; refetching');
  return null;
}

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
    hadDuplicates: false,
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

  // Get target date candles, sorted and one per datetime (Schwab has sent the
  // session twice). The previous day feeds computeOHLC, which reads its first
  // and last candle, so it gets the same treatment.
  const rawTargetCandles = byDate.get(targetDate) ?? [];
  const targetCandles = sortUniqueByDatetime(rawTargetCandles);
  const hadDuplicates = targetCandles.length < rawTargetCandles.length;
  if (hadDuplicates) {
    logger.warn(
      {
        symbol,
        date: targetDate,
        rawCount: rawTargetCandles.length,
        uniqueCount: targetCandles.length,
      },
      'Schwab returned duplicate candles',
    );
  }

  // Get previous trading day
  const sortedDates = [...byDate.keys()].sort((a, b) => a.localeCompare(b));
  const targetIdx = sortedDates.indexOf(targetDate);
  const prevDate = targetIdx > 0 ? sortedDates[targetIdx - 1]! : null;
  const prevCandles = prevDate
    ? sortUniqueByDatetime(byDate.get(prevDate) ?? [])
    : [];
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

  return {
    candles: processed,
    previousClose,
    previousDay,
    ok: true,
    hadDuplicates,
  };
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
        const cached = await readCachedHistory(cacheKey);
        if (cached) {
          metrics.cacheResult('/api/history', true);
          res.setHeader('Cache-Control', cacheControlFor(cached.complete));
          res.setHeader('X-Cache', 'HIT');
          done({ status: 200 });
          return res.status(200).json(cached.response);
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

      const results = [spx, vix, vix1d, vix9d, vvix];

      // One Sentry message per response, however many symbols repeated
      // candles; fetchSymbolHistory logged each symbol's counts.
      if (results.some((s) => s.hadDuplicates)) {
        Sentry.captureMessage('history: duplicate candles from Schwab', {
          level: 'warning',
        });
      }

      // A partially-failed fetch (e.g. $VIX1D times out while $SPX succeeds)
      // must NOT be cached for 90 days — it would serve permanently-empty VIX
      // panels for that date forever. Only the long-TTL write requires every
      // symbol to have succeeded; a partial result falls back to the short TTL
      // so the next request re-fetches and self-heals.
      const allOk = results.every((s) => s.ok);

      // Strip the internal `ok` and `hadDuplicates` flags so they never leak
      // into the cached payload or the JSON response (HistoryResponse
      // intentionally omits them).
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

      // Only a complete past-date response earns the long Redis TTL and the
      // long browser max-age. Today's data is still accumulating, and a
      // partial-failure response must not be cached for a day.
      const complete = !isToday && allOk;
      const entry: CachedHistory = { response, complete };

      // Cache
      try {
        if (isToday) {
          await redis.set(cacheKey, entry, { ex: 120 });
        } else if (complete && spx.candles.length > 0) {
          await redis.set(cacheKey, entry, { ex: PAST_CACHE_TTL });
        } else if (spx.candles.length > 0) {
          // Past date but at least one symbol failed: short TTL so the empty
          // panels don't persist for 90 days. Observable via the per-symbol
          // captureMessage above.
          await redis.set(cacheKey, entry, { ex: 120 });
        }
      } catch (err) {
        logger.error({ err }, 'Failed to cache history');
      }

      res.setHeader('Cache-Control', cacheControlFor(complete));

      done({ status: 200 });
      res.status(200).json(response);
    } catch (error) {
      done({ status: 500, error: 'unhandled' });
      Sentry.captureException(error);
      // sendError sets no-store, replacing any success Cache-Control.
      sendError(res, 500, 'Internal server error');
    }
  });
}
