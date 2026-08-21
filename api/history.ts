/**
 * GET /api/history?date=2026-03-10
 *
 * Returns all 5-minute candles for SPX, VIX, VIX1D, VIX9D, and VVIX
 * for a given trading day. Designed for backtesting: fetch once per date,
 * navigate time on the client.
 *
 * The five symbols are fetched from the priceHistory facade over a [D-5d, D]
 * window (no look-ahead) in sequential pairs (not one 5-wide burst); each
 * gets one retry on a transient failure, and any symbol ($SPX included) that
 * comes back ok-but-empty while another symbol has candles for the session
 * gets one retry too — see the notes on the fan-out in the handler,
 * `isRetryableFailure`, and `refetchIfSilentlyEmpty` below.
 *
 * Owner-or-guest (uses Schwab credentials).
 *
 * Cache strategy:
 *   - Past dates: cached in Redis for 90 days (data never changes) — but only
 *     when every symbol succeeded AND is populated; a partial or silently
 *     empty result is not written at all (the next request refetches) and
 *     gets the short CDN header so the edge self-heals too
 *   - A cached past-date entry is served as a HIT only when it is internally
 *     consistent (every symbol populated, or every symbol empty); a "some
 *     populated, one blank" entry — any malformed write — is treated as a
 *     miss, refetched, and overwritten (see `isConsistent`). Legacy pre-fix
 *     entries are retired wholesale by the `history:v3:` key prefix, not by
 *     this guard.
 *   - All five symbols empty: edge-cached for a day only when the NYSE
 *     calendar says the date was NOT a session (weekend / holiday — the blank
 *     is permanent). A blank on a known trading day is the sidecar/Theta
 *     returning nothing for a session that happened — short header, and one
 *     alert unless it is today before/just after the open (see
 *     `isTradingDay` + `OPEN_GRACE_MINUTES`).
 *   - Today: never written to Redis (no path reads today's key back — the
 *     HIT path is past-dates only, and by tomorrow a short TTL has lapsed);
 *     the CDN's 120s max-age is today's cache. Redis is billed per command,
 *     so dead writes are not written.
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
import { isTradingDay } from '../src/data/marketHours.js';
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

// v3 (2026-08-19): the fetch window changed from [D-7d, D+2d] to [D-5d, D].
// Every v2 entry was written with the look-ahead window, so its
// spx.previousClose / vix.previousClose was D+1's close (or D's own close on
// Thursdays) instead of the prior session's — wrong inputs to the overnight
// gap and RV/IV pre-trade signals. Those entries are internally consistent
// (every symbol populated), so `isConsistent` cannot detect them; bumping the
// prefix retires every v2 entry at the cost of one refetch per date.
const REDIS_PREFIX = 'history:v3:';
const PAST_CACHE_TTL = 90 * 24 * 60 * 60;

/**
 * Backoff before the single retry of a transient per-symbol failure. Long
 * enough for a Theta Terminal burst to drain, short enough to be invisible
 * against the endpoint's normal multi-second fan-out.
 */
const RETRY_DELAY_MS = 300;

/** 9:30 AM ET — the RTH open — in minutes-of-day. */
const RTH_OPEN_ET_MINUTES = 570;

/**
 * How long after the open a still-empty symbol on TODAY is "the feed warming
 * up", not a hole. $VIX1D's first 5-minute print can lag $SPX's, so "SPX has
 * its 9:30 candle, VIX1D has none yet" at 9:36 ET is expected and gets a
 * breadcrumb instead of a Sentry alert; so does an all-five-empty today
 * before the open. Past dates, and today once the grace has elapsed, keep
 * the alert.
 */
const OPEN_GRACE_MINUTES = 10;

/**
 * Is `now` before the open, or within `OPEN_GRACE_MINUTES` of it, in ET?
 * Callers AND this with `isToday` — the clock only says anything about the
 * session being fetched when that session is today's.
 */
function isEarlySession(now: Date): boolean {
  return getETTotalMinutes(now) < RTH_OPEN_ET_MINUTES + OPEN_GRACE_MINUTES;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Is a failed `schwabFetch` worth exactly one retry?
 *
 * Deterministic failures are NOT retried — a second identical request gets
 * the same answer and just burns a call plus `RETRY_DELAY_MS`:
 *   - `501 SOURCE_UNAVAILABLE` — the facade has no source for this symbol.
 *   - `SCHWAB_TOKEN_*` (`code`, from schwab-fetch's OAuth gate: 401
 *     `SCHWAB_TOKEN_EXPIRED` / 500 `SCHWAB_TOKEN_ERROR`) — Schwab configured
 *     but not connected.
 *   - `[SCHWAB_TOKEN_ERROR]` 500 with NO `code` — market-data-adapters'
 *     `mapError` for a `ConfigError` (missing `SIDECAR_URL` / `UW_API_KEY`);
 *     the message prefix is its only marker.
 *   - other 4xx auth/validation failures.
 * What remains is transient: 502 (upstream error), 504 (timeout / network),
 * other 500s, and 429 (rate limited / the sidecar's busy shed).
 */
function isRetryableFailure(result: {
  status?: number;
  code?: string;
  error?: string;
}): boolean {
  if (result.code === 'SOURCE_UNAVAILABLE') return false;
  if (result.code?.startsWith('SCHWAB_TOKEN')) return false;
  if (result.error?.startsWith('[SCHWAB_TOKEN')) return false;
  const status = result.status ?? 0;
  if (status === 501) return false;
  // status 0 = a mocked/degraded envelope with no status; treat as transient.
  return status === 0 || status === 429 || status >= 500;
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

  const path = `/pricehistory?${params.toString()}`;

  let result = await schwabFetch<SchwabPriceHistory>(path);

  // One retry for a transient loss. The five symbols share the Theta Terminal
  // with each other's per-day fan-out, so a symbol that loses the burst race
  // comes back empty and the UI renders "n/a (no history)" for a date whose
  // data exists. A retry-recovered symbol is indistinguishable from a
  // first-try success — same `ok: true`, same `allOk` gate, no alert.
  if (!result.ok && isRetryableFailure(result)) {
    logger.warn(
      { symbol, error: result.error, status: result.status },
      'History fetch failed, retrying once',
    );
    Sentry.addBreadcrumb({
      category: 'history',
      level: 'info',
      message: 'History symbol fetch failed, retrying once',
      data: { symbol, targetDate, error: result.error, status: result.status },
    });
    await sleep(RETRY_DELAY_MS);
    result = await schwabFetch<SchwabPriceHistory>(path);
  }

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

/**
 * Second root-cause path for "$VIX1D empty, other four fine": the sidecar
 * answers "Theta had no data" with a 404, the adapter swallows it
 * (`NoDataError` → `[]`), the facade returns `ok: true` with ZERO candles,
 * and `ok`-only gating would cache the empty symbol for 90 days and never
 * retry or alert. Callers invoke this only when at least one OTHER symbol DID
 * return candles for the date — that proves a session exists, so a symbol
 * with no candles is a transient miss, not a holiday. The check is
 * symmetric: `$SPX` is retried against the Cboe indices just as they are
 * retried against it, so a blank-SPX response cannot vacuously pass the gate
 * and earn the day-long CDN max-age.
 *
 * Returns the input untouched unless it is ok-but-empty; otherwise retries
 * the symbol exactly once after `RETRY_DELAY_MS` and returns whatever the
 * retry produced. A still-empty retry is logged, breadcrumbed, and captured
 * once per symbol so the path is no longer invisible — except when
 * `earlySession` is set (today, before the open or within
 * `OPEN_GRACE_MINUTES` of it): a lagging first print is expected there, so
 * it is breadcrumbed at info level and NOT captured. (A retry that FAILS
 * outright is alerted by `fetchSymbolHistory` itself.)
 */
async function refetchIfSilentlyEmpty(
  symbol: string,
  result: SymbolFetchResult,
  startMs: number,
  endMs: number,
  targetDate: string,
  earlySession: boolean,
): Promise<SymbolFetchResult> {
  if (!result.ok || result.candles.length > 0) return result;

  logger.warn(
    { symbol, targetDate },
    'History symbol returned no candles while another symbol has data for the session, retrying once',
  );
  Sentry.addBreadcrumb({
    category: 'history',
    level: 'info',
    message: 'History symbol ok-but-empty, retrying once',
    data: { symbol, targetDate },
  });
  await sleep(RETRY_DELAY_MS);
  const retried = await fetchSymbolHistory(symbol, startMs, endMs, targetDate);

  if (retried.ok && retried.candles.length === 0) {
    if (earlySession) {
      logger.info(
        { symbol, targetDate },
        'History symbol still empty after retry in the early session (first print may lag); not alerting',
      );
      Sentry.addBreadcrumb({
        category: 'history',
        level: 'info',
        message: 'History symbol still empty after retry (early session)',
        data: { symbol, targetDate, earlySession: true },
      });
      return retried;
    }
    logger.warn(
      { symbol, targetDate },
      'History symbol still empty after retry; not caching long',
    );
    Sentry.addBreadcrumb({
      category: 'history',
      level: 'warning',
      message: 'History symbol still empty after retry',
      data: { symbol, targetDate },
    });
    // Keep the message per-symbol (the date goes in `extra`) so a
    // genuinely-empty past date re-alerting every 120s groups into one
    // Sentry issue instead of one per (symbol, date).
    Sentry.captureMessage(
      `history: ${symbol} returned no candles while another symbol has data for the session`,
      { level: 'warning', extra: { targetDate } },
    );
  }

  return retried;
}

/**
 * Is a cached `HistoryResponse` internally consistent — every symbol
 * populated, or every symbol empty (holiday / no session)? A "some populated,
 * one blank" entry is exactly the "$VIX1D empty, other four fine" payload and
 * must NOT be served as a HIT with the day-long CDN max-age. The handler no
 * longer writes such an entry itself (the 120s short-TTL partial write was
 * dead — nothing read it back — and was dropped), so this is a defence
 * against any malformed entry. Treating it as a miss refetches the date
 * (with the retries above) and overwrites the entry with the correct TTL.
 * Legacy `history:v2:` entries are not healed here — they are retired
 * wholesale by the `REDIS_PREFIX` bump to `history:v3:`.
 */
function isConsistent(r: HistoryResponse): boolean {
  const syms = [r.spx, r.vix, r.vix1d, r.vix9d, r.vvix];
  const populated = syms.filter((s) => s.candles.length > 0).length;
  return populated === 0 || populated === syms.length;
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
      // Today before the open, or within OPEN_GRACE_MINUTES of it: blanks
      // are the feed warming up, not holes — breadcrumb, don't alert.
      const earlySession = isToday && isEarlySession(now);

      if (dateParam > todayET) {
        done({ status: 400 });
        return res
          .status(400)
          .json({ error: 'Cannot fetch history for future dates' });
      }

      // Try Redis cache (past dates are cached long-term). An inconsistent
      // entry — at least one symbol with candles and at least one without —
      // is treated as a MISS (see `isConsistent`) so it is refetched and
      // overwritten rather than served with the day-long CDN header.
      const cacheKey = `${REDIS_PREFIX}${dateParam}`;
      if (!isToday) {
        try {
          const cached = await redis.get<HistoryResponse>(cacheKey);
          if (cached && isConsistent(cached)) {
            metrics.cacheResult('/api/history', true);
            res.setHeader(
              'Cache-Control',
              's-maxage=86400, stale-while-revalidate=3600',
            );
            res.setHeader('X-Cache', 'HIT');
            done({ status: 200 });
            return res.status(200).json(cached);
          }
          if (cached) {
            logger.info(
              { date: dateParam },
              'History cache entry is inconsistent (some symbols blank); refetching',
            );
          }
        } catch {
          // Redis unavailable
        }
      }

      // Time window: [D-5d, D] — NO look-ahead. Only the target date and the
      // previous trading day are used, and 5 calendar days back still spans
      // a 3-day weekend plus a holiday (Mon target → Wed/Thu/Fri/Mon; Tue
      // after a Monday holiday → Thu/Fri/Tue). That is ~4-5 trading dates
      // per symbol ≈ 20 sidecar calls per request, half of the old
      // [D-7d, D+2d] window's ~40. The +2d look-ahead was also a bug: the
      // adapter's `previousClose` is the close of the second-to-last session
      // IN RANGE, so a backtest of D reported TOMORROW's close as prevClose.
      // With D last in range, `previousClose` and `previousDay` both resolve
      // to the session before D.
      const targetMs = new Date(dateParam + 'T12:00:00Z').getTime();
      const startMs = targetMs - 5 * 24 * 60 * 60 * 1000;
      const endMs = targetMs;

      // Fetch the five symbols in sequential pairs, NOT one 5-wide
      // Promise.all. Each symbol fans out per trading day inside the
      // market-data facade at `INDEX_HISTORY_CONCURRENCY = 3` (market-data-
      // adapters.ts; the sidecar serialises /theta/index/* to cap 2 with a
      // 5s wait budget and sheds `503 theta_busy` past it), so a pair round
      // is ~6 simultaneous sidecar arrivals (queue wait ≈ 2T per call) and
      // the trailing $VVIX round ~3. A 5-wide burst would have been ~15
      // arrivals and stacked ≥5T of wait on the tail of the queue — past the
      // budget once Terminal latency T > ~1s — and whichever symbol lost the
      // race came back empty and the UI showed "n/a (no history)" (observed
      // 2026-08-19: $VIX1D empty at 18:31 UTC, all 62 candles present on a
      // re-fetch at 18:38). Pairs cost 3 sequential rounds instead of 1.
      // (`HISTORY_CONCURRENCY = 6` in the same file governs only the UW
      // equity branch and is not on this path.)
      const [spxFirst, vixFirst] = await Promise.all([
        fetchSymbolHistory('$SPX', startMs, endMs, dateParam),
        fetchSymbolHistory('$VIX', startMs, endMs, dateParam),
      ]);
      const [vix1dFirst, vix9dFirst] = await Promise.all([
        fetchSymbolHistory('$VIX1D', startMs, endMs, dateParam),
        fetchSymbolHistory('$VIX9D', startMs, endMs, dateParam),
      ]);
      const vvixFirst = await fetchSymbolHistory(
        '$VVIX',
        startMs,
        endMs,
        dateParam,
      );

      // Silent-empty hole: an `ok: true` symbol with ZERO candles while ANY
      // other symbol has candles for the date is a transient miss (sidecar
      // 404 → NoDataError → []), not a holiday. Retry each such symbol once,
      // sequentially (the sidecar serialises /theta/index/* to a small cap),
      // before deciding what is cacheable. The gate is symmetric — $SPX is
      // retried against the Cboe indices and vice versa — so a blank $SPX
      // cannot slip through as "no session to compare against" and get
      // edge-cached for a day. Only when every symbol is empty is there no
      // session, and nothing is retried.
      const sessionExists = [
        spxFirst,
        vixFirst,
        vix1dFirst,
        vix9dFirst,
        vvixFirst,
      ].some((s) => s.candles.length > 0);
      const settle = (
        symbol: string,
        first: SymbolFetchResult,
      ): Promise<SymbolFetchResult> =>
        sessionExists
          ? refetchIfSilentlyEmpty(
              symbol,
              first,
              startMs,
              endMs,
              dateParam,
              earlySession,
            )
          : Promise.resolve(first);
      const spx = await settle('$SPX', spxFirst);
      const vix = await settle('$VIX', vixFirst);
      const vix1d = await settle('$VIX1D', vix1dFirst);
      const vix9d = await settle('$VIX9D', vix9dFirst);
      const vvix = await settle('$VVIX', vvixFirst);
      const spxHasData = spx.candles.length > 0;

      // A partially-failed fetch (e.g. $VIX1D times out while $SPX succeeds)
      // must NOT be cached for 90 days — it would serve permanently-empty VIX
      // panels for that date forever. Neither may an ok-but-empty symbol
      // ($SPX included) on a date where another symbol proves a session
      // exists. Only a complete, fully-populated result earns the long-TTL
      // write and the long CDN max-age; anything else is not written and
      // gets the short CDN header so the next request re-fetches and
      // self-heals.
      const vixFamily = [vix, vix1d, vix9d, vvix];
      const allOk = spx.ok && vixFamily.every((s) => s.ok);
      const allPopulated =
        !sessionExists ||
        [spx, ...vixFamily].every((s) => s.candles.length > 0);

      // All five empty is only a permanent blank (and so edge-cacheable for a
      // day) when the NYSE calendar says the date was not a session. On a
      // known trading day it is the sidecar/Theta returning nothing for a
      // session that happened — or today's open not having printed yet —
      // and must stay on the short header. `isTradingDay` knows weekends
      // for any date and holidays for the years in
      // `src/data/marketHours.ts` (2025–2026 at the time of writing);
      // outside those years a weekday holiday is treated as a trading day,
      // which errs towards the short header, never the long one.
      const knownTradingDay = isTradingDay(dateParam);
      const silentBlankDay = !sessionExists && knownTradingDay;
      const cacheable = allOk && allPopulated && !silentBlankDay;

      // Alert the silent all-five blank once — but only when every symbol
      // came back ok-but-empty (a failed fetch is already alerted per symbol
      // by `fetchSymbolHistory`) and it is not simply early today.
      if (silentBlankDay && allOk) {
        if (earlySession) {
          logger.info(
            { date: dateParam },
            'History: no symbol returned candles yet in the early session',
          );
          Sentry.addBreadcrumb({
            category: 'history',
            level: 'info',
            message: 'History: no symbol returned candles (early session)',
            data: { targetDate: dateParam, earlySession: true },
          });
        } else {
          logger.warn(
            { date: dateParam },
            'History: no symbol returned candles on a trading day; not caching long',
          );
          Sentry.addBreadcrumb({
            category: 'history',
            level: 'warning',
            message: 'History: no symbol returned candles on a trading day',
            data: { targetDate: dateParam },
          });
          Sentry.captureMessage(
            'history: no symbol returned candles on a trading day',
            { level: 'warning', extra: { targetDate: dateParam } },
          );
        }
      }

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

      // Cache — exactly one write, and only the one that is ever read back:
      // a complete, fully-populated past date for 90 days. Nothing else is
      // written. Today's key is never read (the HIT path is `!isToday`, and
      // by tomorrow a short TTL has lapsed), and a partial / silently-empty
      // past date would be rejected by `isConsistent` on read; both were
      // billed Redis commands per request for nothing. The next request for
      // a non-cacheable date simply refetches.
      try {
        if (!isToday && cacheable && spxHasData) {
          await redis.set(cacheKey, response, { ex: PAST_CACHE_TTL });
        }
      } catch (err) {
        logger.error({ err }, 'Failed to cache history');
      }

      // Only a complete, fully-populated past-date response (or a calendar
      // non-session blank) earns the long CDN max-age. Today's data is still
      // accumulating, and a partial or silently-empty response must not be
      // edge-cached for a day (it mirrors the Redis gate above).
      const longLived = !isToday && cacheable;
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
