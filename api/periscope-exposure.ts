/**
 * GET /api/periscope-exposure
 *
 * Returns the latest UW Periscope MM-attributed exposure slot for
 * today's 0DTE expiry, plus the straddle cone bounds and any breach
 * events. Same data the analyze endpoint injects into Claude's prompt
 * — exposed as JSON so the frontend panel can render it.
 *
 * Cache:
 *   Market hours: 30s edge + 30s SWR  (Periscope updates every 10 min;
 *                                       30s keeps refresh latency low)
 *   After hours: 300s edge + 60s SWR
 *
 * Response shape:
 * {
 *   marketOpen: boolean,
 *   asOf: string (ISO),
 *   data: PeriscopeView | null,   // null when scraper has no slot yet
 * }
 *
 * Auth: owner OR guest (read-only data, same policy as /api/quotes
 * and /api/spy-darkpool-levels — Periscope data is not Anthropic-gated).
 */

import { Sentry, metrics } from './_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  setCacheHeaders,
  isMarketOpen,
  guardOwnerOrGuestEndpoint,
} from './_lib/api-helpers.js';
import { buildPeriscopeView } from './_lib/periscope-format.js';
import type { PeriscopeView } from './_lib/periscope-format.js';
import { getDb } from './_lib/db.js';
import { getETDateStr } from '../src/utils/timezone.js';
import logger from './_lib/logger.js';

/**
 * Read the most recent SPX spot price from `index_candles_1m` for the
 * given date. Used as the authoritative spot for ranking strikes (the
 * periscope skill enforces: never the chart's red dotted line).
 */
async function fetchLatestSpxSpot(date: string): Promise<number | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT close
    FROM index_candles_1m
    WHERE symbol = 'SPX' AND date = ${date}
    ORDER BY timestamp DESC
    LIMIT 1
  `) as Array<{ close: string | number }>;
  if (rows.length === 0) return null;
  const v = Number(rows[0]!.close);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/periscope-exposure');
    const done = metrics.request('/api/periscope-exposure');
    try {
      if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

      const marketOpen = isMarketOpen();
      setCacheHeaders(res, marketOpen ? 30 : 300, marketOpen ? 30 : 60);

      const date = getETDateStr(new Date());

      // Spot can come from query param (when frontend has a fresher
      // value than the DB) or fall back to index_candles_1m.
      const spotParam = (req.query.spot as string | undefined) ?? '';
      const spotFromQuery = Number.parseFloat(spotParam);
      const spot: number | null =
        Number.isFinite(spotFromQuery) && spotFromQuery > 0
          ? spotFromQuery
          : await fetchLatestSpxSpot(date);

      if (spot == null) {
        // No spot at all — can't rank levels. Return marketOpen + null
        // data so the panel can show "waiting for SPX spot".
        done({ status: 200 });
        return res.status(200).json({
          marketOpen,
          asOf: new Date().toISOString(),
          data: null,
          reason: 'no_spot',
        });
      }

      const viewWithFormatterArgs = await buildPeriscopeView({
        date,
        expiry: date,
        spot,
      });

      // Strip the internal _formatterArgs before serializing — those
      // carry the full per-strike row arrays which the panel doesn't
      // need (it only renders the ranked top-N already in the view).
      let data: PeriscopeView | null = null;
      if (viewWithFormatterArgs != null) {
        const view: PeriscopeView = {
          capturedAt: viewWithFormatterArgs.capturedAt,
          priorCapturedAt: viewWithFormatterArgs.priorCapturedAt,
          expiry: viewWithFormatterArgs.expiry,
          spot: viewWithFormatterArgs.spot,
          gamma: viewWithFormatterArgs.gamma,
          charm: viewWithFormatterArgs.charm,
          vanna: viewWithFormatterArgs.vanna,
          signFlips: viewWithFormatterArgs.signFlips,
          cone: viewWithFormatterArgs.cone,
          breaches: viewWithFormatterArgs.breaches,
        };
        data = view;
      }

      done({ status: 200 });
      res.status(200).json({
        marketOpen,
        asOf: new Date().toISOString(),
        data,
        reason: data == null ? 'no_slot' : undefined,
      });
    } catch (error) {
      done({ status: 500, error: 'unhandled' });
      Sentry.captureException(error);
      logger.error({ err: error }, '/api/periscope-exposure handler failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
