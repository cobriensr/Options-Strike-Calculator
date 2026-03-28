/**
 * GET /api/yesterday
 *
 * Returns yesterday's SPX OHLC for the volatility clustering input.
 *
 * Uses Schwab priceHistory: $SPX, daily candles, 1 month lookback.
 * Extracts the most recent completed trading day.
 *
 * Cache:
 *   Market hours: 3600s (1 hour) — yesterday doesn't change
 *   After hours:  86400s (1 day) — won't change until next trading day
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
  rejectIfNotOwner,
  checkBot,
} from './_lib/api-helpers.js';
import { getETDateStr } from '../src/utils/timezone.js';

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

// ============================================================
// HANDLER
// ============================================================

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/yesterday');
    const done = metrics.request('/api/yesterday');
    try {
      // Owner-only: public visitors get 401, frontend falls back to manual input
      if (rejectIfNotOwner(req, res)) {
        done({ status: 401 });
        return;
      }

      const botCheck = await checkBot(req);
      if (botCheck.isBot) {
        done({ status: 403 });
        res.status(403).json({ error: 'Access denied' });
        return;
      }

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

      // Yesterday's data never changes once the day is over
      setCacheHeaders(res, marketOpen ? 3600 : 86400, 3600);

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
