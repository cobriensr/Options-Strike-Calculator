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
 *   ?days=30         — how many days to return (default 30, max 90; a whole
 *                      number, so 30.5 is read as 30)
 *   ?from=YYYY-MM-DD — first day of the window (default today ET). A past date
 *                      returns that date's events; the window is from..from+days.
 *                      Bounds: 2025-01-01 to today + 90 days, else 400. A `from`
 *                      lookup that misses the cache is limited to 30 a minute
 *                      per IP (429); requests without `from` are never limited.
 *
 * Environment variables:
 *   FRED_API_KEY    — Free key from https://fred.stlouisfed.org/docs/api/api_key.html
 *   FINNHUB_API_KEY — Free key from https://finnhub.io/register (optional, earnings only)
 */

import { Sentry, metrics } from './_lib/sentry.js';
import {
  checkBot,
  rejectIfRateLimited,
  respondIfInvalid,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { withRequestScope } from './_lib/request-scope.js';
import { limiterRedis } from './_lib/redis.js';
import logger from './_lib/logger.js';
import {
  CACHE_TTL_SEC,
  fetchMarketEvents,
  type EventItem,
} from './_lib/market-events.js';
import { eventsQuerySchema } from './_lib/validation.js';
import { getETToday } from '../src/utils/timezone.js';

// v3: the PPI and JOLTS release IDs were corrected, so a v2 entry can name the
// wrong days.
const REDIS_KEY = 'events:v3';
const DAY_MS = 24 * 60 * 60 * 1000;

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

      const parsed = eventsQuerySchema.safeParse(req.query);
      if (respondIfInvalid(parsed, res, done)) return;

      if (!process.env.FRED_API_KEY) {
        done({ status: 500 });
        logger.error('FRED_API_KEY not configured');
        return res
          .status(500)
          .json({ error: 'Service temporarily unavailable' });
      }

      // Parse days parameter (default 30, max 90). A whole number, so
      // ?days=30.5 shares the days=30 cache key instead of minting its own.
      const daysParam = Number(req.query?.days) || 30;
      const days = Math.min(Math.max(Math.trunc(daysParam), 1), 90);

      // Date range: from (default today ET) → from + days. Calendar
      // arithmetic on 12:00 UTC, so a DST change inside the window cannot
      // shift the end date.
      const startDate = parsed.data.from ?? getETToday();
      const endDate = new Date(
        Date.parse(`${startDate}T12:00:00Z`) + days * DAY_MS,
      )
        .toISOString()
        .slice(0, 10);

      // Try Redis cache first. Both cache calls here use the fail-fast
      // `limiterRedis` (one attempt, 1.5 s): a miss falls through to the
      // sources, so the retrying client's ~64 s give-up in an outage would only
      // add latency, on the read and again on the write.
      const cacheKey = `${REDIS_KEY}:${startDate}:${days}`;
      let hit: { events: EventItem[]; cachedAt: number | null } | null = null;
      try {
        // `data` is untrusted: the entry comes from Redis, not from this code.
        const raw = await limiterRedis.get<
          { data?: unknown; cachedAt: number } | EventItem[]
        >(cacheKey);
        if (raw) {
          // Support both new wrapper format and legacy plain array
          if (Array.isArray(raw)) {
            hit = { events: raw, cachedAt: null };
          } else if (Array.isArray(raw.data)) {
            hit = { events: raw.data, cachedAt: raw.cachedAt };
          } else {
            // A hit never rewrites its key and the TTL is 7 days, so serving
            // this one would answer `events: undefined` all week. A miss
            // refetches, and the write below replaces it.
            logger.warn({ key: cacheKey }, 'Malformed events cache entry');
          }
        }
      } catch (err) {
        // Redis unavailable — fetch fresh
        logger.warn({ err }, 'Failed to read events from Redis');
      }

      // Answered outside the read's try: a throw here is a handler error (the
      // catch below sends Sentry and a 500), not a cache miss. Inside the try it
      // would log as a failed Redis read and fall through to a second response.
      if (hit) {
        metrics.cacheResult('/api/events', true);
        setCacheHeaders(res, 300, 120);
        res.setHeader('X-Cache', 'HIT');
        if (hit.cachedAt) {
          res.setHeader(
            'X-Cache-Age',
            Math.round((Date.now() - hit.cachedAt) / 1000),
          );
        }
        done({ status: 200 });
        return res.status(200).json({
          events: hit.events,
          startDate,
          endDate,
          cached: true,
          asOf: new Date().toISOString(),
        });
      }

      // A cache miss costs at most one Finnhub call (none for a window that ends
      // more than 45 days before today, or when no Finnhub key is set), plus at
      // most 7 FRED calls when a release's date list is cold in Redis, which
      // happens about once per 12 hours, or on every miss for a release FRED
      // answers with an empty list, which is never kept (`market-events.ts`).
      // Finnhub's free key allows 60 calls a minute, and the default request
      // shares it. Limit per IP only the lookups that choose their own window
      // (`from`): this caps one IP at 30 misses a minute and leaves the default
      // request unlimited. A cache hit never reaches here.
      if (
        parsed.data.from &&
        (await rejectIfRateLimited(req, res, 'events', 30))
      ) {
        done({ status: 429 });
        return;
      }

      // Fetch from all sources
      const { events, complete } = await fetchMarketEvents(startDate, endDate);

      // Only cache when every source returned OK. A FRED blip (a non-OK
      // answer, a malformed body or an empty release list) degrades the list
      // for those releases; caching that under the day-scoped key would serve
      // a missing CPI/NFP flag all day (AUD-M2). Skipping the write lets the
      // next request retry FRED.
      if (complete) {
        // Cache in Redis for 7 days (key is date-scoped, stale keys auto-expire)
        try {
          await limiterRedis.set(
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
