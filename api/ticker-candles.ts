/**
 * GET /api/ticker-candles
 *
 * Owner-or-guest read endpoint backing the stock-price overlay on
 * the per-fire Net Flow chart inside LotteryFinderRow. Returns
 * 1-minute regular-session candles for a single ticker on a
 * trading date via Schwab pricehistory.
 *
 * Query params: ?ticker= ?date=
 * Validated by `tickerCandlesQuerySchema` in api/_lib/validation.ts.
 *
 * Why a dedicated endpoint: net-flow-history serves per-tick option
 * premium aggregates from our daemon's DB; the underlying spot
 * lives at Schwab. Splitting the two keeps each endpoint's caching
 * profile clean — net-flow polls every 30s during market hours,
 * candles can cache more aggressively (60s during, 600s after).
 *
 * Schwab pricehistory: $TICKER, periodType=day, period=1,
 * frequencyType=minute, frequency=1, regular-session only.
 *
 * Cache:
 *   Market hours: 60s edge cache + 30s SWR
 *   After hours:  600s edge cache + 120s SWR
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Sentry, metrics } from './_lib/sentry.js';
import {
  schwabFetch,
  setCacheHeaders,
  isMarketOpen,
  guardOwnerOrGuestEndpoint,
} from './_lib/api-helpers.js';
import { tickerCandlesQuerySchema } from './_lib/validation.js';
import { getETDateStr, getETTotalMinutes } from '../src/utils/timezone.js';

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

/** Compact per-minute candle shape returned to clients. */
export interface TickerCandle {
  /** UTC ISO timestamp at the start of the minute. */
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/ticker-candles');
    const done = metrics.request('/api/ticker-candles');
    try {
      if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

      const parsed = tickerCandlesQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        done({ status: 400, error: 'validation' });
        res.status(400).json({
          error: 'invalid query',
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        });
        return;
      }
      const { ticker, date } = parsed.data;
      const targetDate = date ?? getETDateStr(new Date());

      // 5-day window covers any holiday combination — Schwab snaps
      // pricehistory bounds to session boundaries and a tight 24h
      // window can collapse to zero candles around weekends. We
      // filter to the requested ET date below.
      const now = new Date();
      const endMs = now.getTime();
      const startMs = endMs - 5 * 24 * 60 * 60 * 1000;

      const params = new URLSearchParams({
        symbol: ticker,
        periodType: 'day',
        period: '1',
        frequencyType: 'minute',
        frequency: '1',
        startDate: String(startMs),
        endDate: String(endMs),
        needExtendedHoursData: 'false',
        needPreviousClose: 'true',
      });

      const result = await schwabFetch<SchwabPriceHistory>(
        `/pricehistory?${params.toString()}`,
      );

      if (!result.ok) {
        done({ status: 502, error: 'schwab' });
        res.status(502).json({
          error: 'schwab pricehistory failed',
          upstream: result.status,
          detail: result.error,
        });
        return;
      }

      // Filter to the requested ET trading date and regular session
      // (≥ 9:30 AM ET = 570 minutes-of-day).
      const sessionCandles: TickerCandle[] = [];
      for (const c of result.data.candles) {
        const d = new Date(c.datetime);
        if (getETDateStr(d) !== targetDate) continue;
        if (getETTotalMinutes(d) < 570) continue;
        sessionCandles.push({
          ts: d.toISOString(),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        });
      }

      const marketOpen = isMarketOpen();
      setCacheHeaders(res, marketOpen ? 60 : 600, marketOpen ? 30 : 120);

      done({ status: 200 });
      res.status(200).json({
        ticker,
        date: targetDate,
        previousClose: result.data.previousClose,
        count: sessionCandles.length,
        candles: sessionCandles,
        marketOpen,
        asOf: new Date().toISOString(),
      });
    } catch (error) {
      done({ status: 500, error: 'unhandled' });
      Sentry.captureException(error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
