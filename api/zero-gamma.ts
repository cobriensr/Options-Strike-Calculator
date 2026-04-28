/**
 * GET /api/zero-gamma
 *
 * Owner-or-guest read endpoint for the derived zero-gamma level. Returns the
 * latest row for `ticker` (default 'SPX') plus the most recent 100 rows for
 * trend / chart consumption.
 *
 * Owner-or-guest because `gamma_curve` exposes per-strike-derived aggregates
 * from UW (OPRA-licensed) data — same category as /api/spot-gex-history,
 * /api/greek-exposure-strike, and /api/gex-per-strike.
 *
 * Query params:
 *   ?ticker=SPX  — 1-5 uppercase letters; defaults to SPX
 *
 * Response:
 *   {
 *     latest: ZeroGammaRow | null,
 *     history: ZeroGammaRow[]  // DESC by ts, up to 100 rows
 *   }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from './_lib/db.js';
import { Sentry, metrics } from './_lib/sentry.js';
import logger from './_lib/logger.js';
import {
  guardOwnerOrGuestEndpoint,
  isMarketOpen,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { zeroGammaQuerySchema } from './_lib/validation.js';

const DEFAULT_TICKER = 'SPX';
const HISTORY_LIMIT = 100;

export interface ZeroGammaRow {
  ticker: string;
  spot: number;
  zeroGamma: number | null;
  confidence: number | null;
  netGammaAtSpot: number | null;
  gammaCurve: unknown;
  ts: string;
}

export interface ZeroGammaResponse {
  latest: ZeroGammaRow | null;
  history: ZeroGammaRow[];
}

/**
 * Postgres NUMERIC columns arrive as strings from the Neon serverless
 * driver but may also arrive as numbers depending on the column's
 * declared type — normalize both and allow NULL.
 */
type NumericFromDb = string | number | null;

interface RawRow {
  ticker: string;
  spot: string | number;
  zero_gamma: NumericFromDb;
  confidence: NumericFromDb;
  net_gamma_at_spot: NumericFromDb;
  gamma_curve: unknown;
  ts: string | Date;
}

function toIso(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function parseNumOrNull(value: NumericFromDb): number | null {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function mapRow(r: RawRow): ZeroGammaRow {
  return {
    ticker: r.ticker,
    spot: Number(r.spot),
    zeroGamma: parseNumOrNull(r.zero_gamma),
    confidence: parseNumOrNull(r.confidence),
    netGammaAtSpot: parseNumOrNull(r.net_gamma_at_spot),
    gammaCurve: r.gamma_curve,
    ts: toIso(r.ts),
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/zero-gamma');
    const done = metrics.request('/api/zero-gamma');

    if (req.method !== 'GET') {
      done({ status: 405 });
      return res.status(405).json({ error: 'GET only' });
    }

    if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

    const parsed = zeroGammaQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.setHeader('Cache-Control', 'no-store');
      done({ status: 400 });
      return res.status(400).json({
        error: parsed.error.issues[0]?.message ?? 'Invalid query',
      });
    }

    const ticker = parsed.data.ticker ?? DEFAULT_TICKER;

    try {
      const sql = getDb();

      const rows = (await sql`
        SELECT ticker, spot, zero_gamma, confidence,
               net_gamma_at_spot, gamma_curve, ts
        FROM zero_gamma_levels
        WHERE ticker = ${ticker}
        ORDER BY ts DESC
        LIMIT ${HISTORY_LIMIT}
      `) as RawRow[];

      const history = rows.map(mapRow);
      const latest = history[0] ?? null;

      const response: ZeroGammaResponse = { latest, history };

      // Short edge cache during market hours (cron writes every 5 min,
      // matched to fetch-strike-exposure). Longer cache off-hours to reduce
      // load. setCacheHeaders adds Vary: Cookie so owner vs anon caches
      // don't collide.
      setCacheHeaders(res, isMarketOpen() ? 30 : 300, 60);
      done({ status: 200 });
      return res.status(200).json(response);
    } catch (err) {
      done({ status: 500 });
      Sentry.captureException(err);
      logger.error({ err, ticker }, 'zero-gamma fetch error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
