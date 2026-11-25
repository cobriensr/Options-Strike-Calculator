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
 * A body whose `yesterday.date` is not the last trading day before today is
 * not cached at all, so the client's next poll asks Schwab again.
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
import { priorTradingDay } from '../src/data/marketHours.js';

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
 * Whole seconds from `now` to the next 00:00 ET. It asks for the instant of
 * the next ET midnight, so it is right on the 23- and 25-hour DST days that a
 * "24 h minus the wall clock" count gets wrong (that is also why it does not
 * reuse `msUntilNextETMidnight`, which counts that way and adds a second of
 * slack, which lands past midnight).
 *
 * The time of day is 24:00 on today's date, not 00:00 on tomorrow's.
 * `etWallClockToUtcIso` reads the zone's offset at noon of the date it is
 * given, and Sunday's noon is already on the new offset on the Saturday before
 * a DST change, while Sunday's midnight is still on the old one. Today's noon
 * is on the offset in force at the next midnight, because a DST change falls
 * at 2 AM, never at midnight. `Date.UTC` rolls hour 24 or more into the next
 * day.
 *
 * 0 when the instant can't be worked out, so the caller caches nothing.
 */
function secondsUntilNextETMidnight(now: Date): number {
  const iso = etWallClockToUtcIso(getETDateStr(now), 24 * 60);
  if (iso == null) return 0;
  const seconds = Math.floor((Date.parse(iso) - now.getTime()) / 1000);
  return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
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
      const now = new Date();
      const today = getETDateStr(now);
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
      //
      // And only a body for the right day is cached at all. The client asks
      // with the same ?d=<ET date> until midnight, so a cached body is the
      // answer to every poll. If Schwab lags (the last daily candle is an
      // older session) or the holiday calendar has a gap, the body names
      // another day, and caching it would keep the page's yesterday blank all
      // day. Uncached, the next poll asks Schwab again.
      if (yesterday?.date === priorTradingDay(today)) {
        const toMidnight = secondsUntilNextETMidnight(now);
        const edgeSec = Math.min(marketOpen ? 3600 : 86400, toMidnight);
        const swr = Math.min(3600, toMidnight - edgeSec);
        setCacheHeaders(res, edgeSec, swr);
      } else {
        setCacheHeaders(res, 0, 0);
      }

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
