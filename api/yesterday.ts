/**
 * GET /api/yesterday
 *
 * Returns yesterday's SPX OHLC for the volatility clustering input.
 *
 * Uses Schwab priceHistory: $SPX, daily candles, 1 month lookback.
 * Extracts the most recent completed trading day.
 *
 * Cache (edge, s-maxage), never past the next 00:00 ET:
 *   Market hours: 3600s (1 hour) — yesterday doesn't change
 *   After hours:  86400s (1 day) — won't change until next trading day
 * Each is cut to the time left until midnight ET, and the stale-while-
 * revalidate window (3600s) to what is left after that: from the next ET
 * midnight the body names the wrong session, so it must not be served.
 *
 * Response:
 * {
 *   yesterday: { date, open, high, low, close, rangePct, rangePts },
 *   twoDaysAgo: { date, open, high, low, close, rangePct, rangePts } | null,
 *   asOf: ISO string
 * }
 */

import { Sentry, metrics } from './_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  schwabFetch,
  setCacheHeaders,
  isMarketOpen,
} from './_lib/api-helpers.js';
import { guardOwnerOrGuestEndpoint } from './_lib/guest-auth.js';
import { getETDateStr, etWallClockToUtcIso } from '../src/utils/timezone.js';

// ============================================================
// TYPES
// ============================================================

interface SchwabDailyCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  datetime: number; // Unix ms, midnight of trading day
}

interface SchwabPriceHistory {
  symbol: string;
  empty: boolean;
  candles: SchwabDailyCandle[];
}

interface DaySummary {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  rangePct: number; // (high - low) / open * 100
  rangePts: number; // high - low
}

// ============================================================
// HELPERS
// ============================================================

function msToDateStr(ms: number): string {
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function toDaySummary(candle: SchwabDailyCandle): DaySummary {
  const rangePts = Math.round((candle.high - candle.low) * 100) / 100;
  const rangePct =
    Math.round(((candle.high - candle.low) / candle.open) * 10000) / 100;
  return {
    date: msToDateStr(candle.datetime),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    rangePct,
    rangePts,
  };
}

/**
 * Get today's date in ET timezone as YYYY-MM-DD.
 */
function todayET(): string {
  return getETDateStr(new Date());
}

/** The calendar date after `date` (YYYY-MM-DD). */
function nextDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Whole seconds from `now` to the next 00:00 ET. Exact on a DST day, whose
 * midnight to midnight is 23 or 25 hours, because it asks for the instant of
 * the next ET midnight instead of counting 24 hours off the wall clock. 0 when
 * that instant can't be worked out, so the caller caches nothing.
 */
function secondsUntilNextETMidnight(now: Date): number {
  const iso = etWallClockToUtcIso(nextDate(getETDateStr(now)), 0);
  if (iso == null) return 0;
  return Math.max(0, Math.floor((Date.parse(iso) - now.getTime()) / 1000));
}

// ============================================================
// HANDLER
// ============================================================

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/yesterday');
    const done = metrics.request('/api/yesterday');
    try {
      // Standard guard order (bot check → auth check) via the shared
      // helper. Swapped from manual two-step on 2026-05-19 for
      // consistency with the rest of api/ — also avoids wasting a
      // botid credit on unauthenticated requests by bot-checking first.
      if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

      const params = new URLSearchParams({
        symbol: '$SPX',
        periodType: 'month',
        period: '1',
        frequencyType: 'daily',
        frequency: '1',
      });

      const result = await schwabFetch<SchwabPriceHistory>(
        `/pricehistory?${params.toString()}`,
      );

      if (!result.ok) {
        done({ status: result.status, error: 'schwab' });
        return res.status(result.status).json({ error: result.error });
      }

      const { candles } = result.data;

      if (candles.length === 0) {
        done({ status: 200 });
        return res.status(200).json({
          yesterday: null,
          twoDaysAgo: null,
          asOf: new Date().toISOString(),
        });
      }

      // Filter out today's candle if market is still open
      // (Schwab may include a partial today candle)
      const today = todayET();
      const completed = candles.filter(
        (c) => msToDateStr(c.datetime) !== today,
      );

      // Most recent completed = yesterday, second most recent = two days ago
      // (for multi-day clustering streaks)
      const yesterday =
        completed.length > 0 ? toDaySummary(completed.at(-1)!) : null;

      const twoDaysAgo =
        completed.length > 1 ? toDaySummary(completed.at(-2)!) : null;

      // Last 5 completed trading days (for rolling Parkinson RV)
      const priorDays = completed.slice(-5).map(toDaySummary);

      const marketOpen = isMarketOpen();

      // Yesterday's data never changes once the day is over, but which day is
      // "yesterday" does: from the next ET midnight this body names the wrong
      // session. So no cache entry outlives the day it was made in. s-maxage
      // is the usual lifetime or the time left until midnight, whichever is
      // less, and the stale-while-revalidate window is cut so the two together
      // cannot cross it.
      const toMidnight = secondsUntilNextETMidnight(new Date());
      const edgeSec = Math.min(marketOpen ? 3600 : 86400, toMidnight);
      const swr = Math.min(3600, toMidnight - edgeSec);
      setCacheHeaders(res, edgeSec, swr);

      done({ status: 200 });
      res.status(200).json({
        yesterday,
        twoDaysAgo,
        priorDays,
        asOf: new Date().toISOString(),
      });
    } catch (error) {
      done({ status: 500, error: 'unhandled' });
      Sentry.captureException(error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
