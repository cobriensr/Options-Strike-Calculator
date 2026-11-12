/**
 * GET /api/events
 *
 * Returns upcoming market events from multiple sources (built in
 * `_lib/market-events.ts`):
 *   - FRED API: CPI, NFP, GDP, PCE, PPI, Retail Sales, JOLTS
 *   - Static: FOMC dates, half-day/early close dates
 *   - Finnhub API: Mega-cap earnings (AAPL, MSFT, NVDA, AMZN, GOOG, META, TSLA)
 *
 * Public endpoint — no owner gate. All data is publicly available.
 * Results cached in Upstash Redis for 7 days (key is date-scoped), but only
 * when every source returned OK — a FRED error skips the cache write so a
 * later request can retry (AUD-M2).
 *
 * Query params:
 *   ?days=30  — how many days ahead to return (default 30, max 90)
 *
 * Environment variables:
 *   FRED_API_KEY    — Free key from https://fred.stlouisfed.org/docs/api/api_key.html
 *   FINNHUB_API_KEY — Free key from https://finnhub.io/register (optional, earnings only)
 */

import { Sentry, metrics } from './_lib/sentry.js';
import { checkBot, setCacheHeaders } from './_lib/api-helpers.js';
import { withRequestScope } from './_lib/request-scope.js';
import { redis } from './_lib/redis.js';
import logger from './_lib/logger.js';
import {
  CACHE_TTL_SEC,
  fetchMarketEvents,
  type EventItem,
} from './_lib/market-events.js';
import { getETDateStr } from '../src/utils/timezone.js';

const REDIS_KEY = 'events:v2';

// ============================================================
// HANDLER
// ============================================================

export default withRequestScope(
  'GET',
  '/api/events',
  async (req, res, done) => {
    try {
      const botCheck = await checkBot(req);
      if (botCheck.isBot) {
        done({ status: 403 });
        return res.status(403).json({ error: 'Access denied' });
      }

      if (!process.env.FRED_API_KEY) {
        done({ status: 500 });
        logger.error('FRED_API_KEY not configured');
        return res
          .status(500)
          .json({ error: 'Service temporarily unavailable' });
      }

      // Parse days parameter (default 30, max 90)
      const daysParam = Number(req.query?.days) || 30;
      const days = Math.min(Math.max(daysParam, 1), 90);

      // Date range: today → today + days
      const now = new Date();
      const startDate = getETDateStr(now);
      const endDate = getETDateStr(
        new Date(now.getTime() + days * 24 * 60 * 60 * 1000),
      );

      // Try Redis cache first
      const cacheKey = `${REDIS_KEY}:${startDate}:${days}`;
      try {
        const raw = await redis.get<
          { data: EventItem[]; cachedAt: number } | EventItem[]
        >(cacheKey);
        if (raw) {
          metrics.cacheResult('/api/events', true);
          setCacheHeaders(res, 300, 120);
          res.setHeader('X-Cache', 'HIT');
          // Support both new wrapper format and legacy plain array
          const cachedEvents = Array.isArray(raw) ? raw : raw.data;
          const cachedAt = Array.isArray(raw) ? null : raw.cachedAt;
          if (cachedAt) {
            res.setHeader(
              'X-Cache-Age',
              Math.round((Date.now() - cachedAt) / 1000),
            );
          }
          done({ status: 200 });
          return res.status(200).json({
            events: cachedEvents,
            startDate,
            endDate,
            cached: true,
            asOf: new Date().toISOString(),
          });
        }
      } catch {
        // Redis unavailable — fetch fresh
      }

      // Fetch from all sources
      const { events, complete } = await fetchMarketEvents(startDate, endDate);

      // Only cache when every source returned OK. A FRED blip degrades the
      // list to [] for those releases; caching that under the day-scoped key
      // would serve a missing CPI/NFP flag all day (AUD-M2). Skipping the
      // write lets the next request retry FRED.
      if (complete) {
        // Cache in Redis for 7 days (key is date-scoped, stale keys auto-expire)
        try {
          await redis.set(
            cacheKey,
            { data: events, cachedAt: Date.now() },
            { ex: CACHE_TTL_SEC },
          );
        } catch (err) {
          logger.error({ err }, 'Failed to cache events in Redis');
        }
      }

      setCacheHeaders(res, 300, 120);
      res.setHeader('X-Cache', 'MISS');

      done({ status: 200 });
      res.status(200).json({
        events,
        startDate,
        endDate,
        cached: false,
        asOf: new Date().toISOString(),
      });
    } catch (error) {
      done({ status: 500, error: 'unhandled' });
      Sentry.captureException(error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);
