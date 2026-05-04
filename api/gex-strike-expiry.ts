/**
 * GET /api/gex-strike-expiry
 *
 * Owner-or-guest read endpoint backing the Strike Battle Map panel
 * (Phase 1 of docs/superpowers/specs/strike-battle-map-2026-05-03.md).
 *
 * Reads from `ws_gex_strike_expiry` (populated by the uw-stream daemon's
 * `gex_strike_expiry:<TICKER>` WS handler). Returns the latest GEX row
 * per strike for a (ticker, expiry), optionally snapshotted to a
 * specific timestamp via `at` for the historical scrubber.
 *
 * Owner-or-guest tier because the data derives from UW (OPRA-licensed
 * options flow) — same access category as /api/zero-gamma and
 * /api/greek-flow.
 *
 * Query params:
 *   ?ticker=SPY|QQQ        — required
 *   ?expiry=YYYY-MM-DD     — required (typically today's 0DTE)
 *   ?at=<ISO timestamp>    — optional; latest row per strike at-or-before
 *                            this timestamp. Omit for live latest.
 *
 * Response:
 *   {
 *     ticker: string,
 *     expiry: string,
 *     at: string | null,
 *     rows: GexStrikeExpiryRow[],
 *     asOf: string
 *   }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Sentry, metrics } from './_lib/sentry.js';
import logger from './_lib/logger.js';
import {
  guardOwnerOrGuestEndpoint,
  isMarketOpen,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { gexStrikeExpiryQuerySchema } from './_lib/validation.js';
import {
  getLatestGexPerStrike,
  type GexStrikeExpiryRow,
  type GexStrikeExpiryTicker,
} from './_lib/db-gex-strike-expiry.js';

export interface GexStrikeExpiryResponse {
  ticker: GexStrikeExpiryTicker;
  expiry: string;
  at: string | null;
  rows: GexStrikeExpiryRow[];
  asOf: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/gex-strike-expiry');
    const done = metrics.request('/api/gex-strike-expiry');

    if (req.method !== 'GET') {
      done({ status: 405 });
      return res.status(405).json({ error: 'GET only' });
    }

    if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

    const parsed = gexStrikeExpiryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.setHeader('Cache-Control', 'no-store');
      done({ status: 400 });
      return res.status(400).json({
        error: parsed.error.issues[0]?.message ?? 'Invalid query',
      });
    }

    const { ticker, expiry, at } = parsed.data;
    const asOf = new Date().toISOString();

    try {
      const rows = await getLatestGexPerStrike({
        ticker,
        expiry,
        at: at ?? null,
      });

      const response: GexStrikeExpiryResponse = {
        ticker,
        expiry,
        at: at ?? null,
        rows,
        asOf,
      };

      // Match the live Greek-flow panel cadence: short cache during
      // market hours so the daemon's UPSERTs surface quickly, longer
      // off-hours since values are settled. Vary on Cookie so the
      // owner / guest / anon caches don't collide.
      setCacheHeaders(res, isMarketOpen() ? 30 : 300, 60);
      done({ status: 200 });
      return res.status(200).json(response);
    } catch (err) {
      done({ status: 500 });
      Sentry.captureException(err);
      logger.error(
        { err, ticker, expiry, at },
        'gex-strike-expiry fetch error',
      );
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
