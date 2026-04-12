/**
 * GET /api/vix1d-daily
 *
 * Serves the VIX1D daily OHLC map for backtesting. Reads from the Redis key
 * written by the `refresh-vix1d` cron. Returns 404 when the cron has not yet
 * run (e.g., fresh deploy) so the frontend can fall back to the static
 * `public/vix1d-daily.json` baseline.
 *
 * Public — no auth required (same as the static file it replaces).
 * Cached for 24 hours at the CDN layer.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Sentry, metrics } from './_lib/sentry.js';
import { redis } from './_lib/schwab.js';
import { setCacheHeaders } from './_lib/api-helpers.js';
import type { Vix1dDailyMap } from './cron/refresh-vix1d.js';

const REDIS_KEY = 'vix1d:daily-map';
/** 24 hours — cron refreshes daily. */
const CACHE_TTL = 24 * 60 * 60;

export default async function handler(
  _req: VercelRequest,
  res: VercelResponse,
) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/vix1d-daily');
    const done = metrics.request('/api/vix1d-daily');

    try {
      const dailyMap = await redis.get<Vix1dDailyMap>(REDIS_KEY);

      if (!dailyMap || Object.keys(dailyMap).length === 0) {
        done({ status: 404 });
        return res.status(404).json({
          error: 'VIX1D data not yet populated — cron has not run',
        });
      }

      setCacheHeaders(res, CACHE_TTL, CACHE_TTL / 2);
      res.setHeader('X-Day-Count', String(Object.keys(dailyMap).length));

      done({ status: 200 });
      return res.status(200).json(dailyMap);
    } catch (error) {
      Sentry.captureException(error);
      done({ status: 500, error: 'unhandled' });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
}
