/**
 * GET /api/dealer-regime
 *
 * Owner-or-guest read endpoint backing the Dealer Regime Tile
 * (Phase 2 of docs/superpowers/specs/dealer-regime-tile-2026-05-03.md).
 *
 * Returns the latest `zero_gamma_levels` row per ticker for the four
 * tickers in `zero-gamma-tickers.ts` (SPX, NDX, SPY, QQQ). The frontend
 * classifier consumes these rows and maps each to one of:
 *   `long-γ` / `short-γ` / `transition` / `uncertain`
 *
 * Owner-or-guest tier because the data derives from UW (OPRA-licensed)
 * spot exposures — same access category as `/api/zero-gamma` and
 * `/api/gex-strike-expiry`.
 *
 * No query params. Any provided params are rejected via the strict
 * schema so probes that smuggle data through the URL get a clean 400.
 *
 * Response:
 *   {
 *     rows: DealerRegimeRow[],
 *     asOf: string  // ISO timestamp of this response
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
import { dealerRegimeQuerySchema } from './_lib/validation.js';
import {
  getLatestDealerRegime,
  type DealerRegimeRow,
} from './_lib/db-dealer-regime.js';

export interface DealerRegimeResponse {
  rows: DealerRegimeRow[];
  asOf: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/dealer-regime');
    const done = metrics.request('/api/dealer-regime');

    if (req.method !== 'GET') {
      done({ status: 405 });
      return res.status(405).json({ error: 'GET only' });
    }

    if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

    const parsed = dealerRegimeQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.setHeader('Cache-Control', 'no-store');
      done({ status: 400 });
      return res.status(400).json({
        error: parsed.error.issues[0]?.message ?? 'Invalid query',
      });
    }

    const asOf = new Date().toISOString();

    try {
      const rows = await getLatestDealerRegime();
      const response: DealerRegimeResponse = { rows, asOf };

      // Cron writes every 5 min during market hours; 30s edge cache
      // matches the polling cadence used by the tile + sibling panels.
      // Off-hours: longer cache since values are settled.
      setCacheHeaders(res, isMarketOpen() ? 30 : 300, 60);
      done({ status: 200 });
      return res.status(200).json(response);
    } catch (err) {
      done({ status: 500 });
      Sentry.captureException(err);
      logger.error({ err }, 'dealer-regime fetch error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
