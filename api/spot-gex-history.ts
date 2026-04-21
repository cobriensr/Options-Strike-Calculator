/**
 * GET /api/spot-gex-history
 *
 * Returns the intraday SPX spot GEX timeseries for one trading date,
 * plus the last 30 distinct dates for which SPX rows exist. Powers the
 * `FuturesGammaPlaybook` regime timeline and backtest scrubber.
 *
 * Query params:
 *   ?date=YYYY-MM-DD — target trading date (ET). When omitted, defaults
 *                      to the latest ET date with rows in spot_exposures.
 *
 * Response:
 *   {
 *     date: string,                          // resolved trading date
 *     timestamp: string,                     // latest snapshot ts for date
 *     series: { ts, netGex, spot }[],        // ASC by timestamp
 *     availableDates: string[]               // last 30 distinct dates, DESC
 *   }
 *
 * Owner-gated — spot_exposures derives from UW API data (OPRA compliance).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from './_lib/db.js';
import { Sentry } from './_lib/sentry.js';
import {
  checkBot,
  isMarketOpen,
  rejectIfNotOwner,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import logger from './_lib/logger.js';
import { spotGexHistoryQuerySchema } from './_lib/validation.js';

const TICKER = 'SPX';
const AVAILABLE_DATES_LIMIT = 30;

export interface SpotGexPoint {
  ts: string;
  netGex: number;
  spot: number;
}

export interface SpotGexHistoryResponse {
  date: string | null;
  timestamp: string | null;
  series: SpotGexPoint[];
  availableDates: string[];
}

/**
 * Normalize a Postgres TIMESTAMPTZ / DATE value to an ISO 8601 UTC string.
 * The Neon serverless driver returns these columns as JS Date objects when
 * using the SQL template tag; keeping the response canonical keeps the
 * frontend scrubber's `indexOf` comparisons reliable.
 */
function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const str = String(value);
  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime()) ? str : parsed.toISOString();
}

/**
 * Normalize a Postgres DATE column to YYYY-MM-DD.
 */
function toDateString(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const str = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime())
    ? null
    : parsed.toISOString().slice(0, 10);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/spot-gex-history');

    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'GET only' });
    }

    const botCheck = await checkBot(req);
    if (botCheck.isBot) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (rejectIfNotOwner(req, res)) return;

    const parsed = spotGexHistoryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(400).json({
        error: parsed.error.issues[0]?.message ?? 'Invalid query',
      });
    }

    try {
      const sql = getDb();

      // ── 1. availableDates — last 30 distinct SPX dates, DESC ────
      const dateRows = (await sql`
        SELECT DISTINCT date
        FROM spot_exposures
        WHERE ticker = ${TICKER}
        ORDER BY date DESC
        LIMIT ${AVAILABLE_DATES_LIMIT}
      `) as Array<{ date: string | Date }>;

      const availableDates = dateRows
        .map((r) => toDateString(r.date))
        .filter((d): d is string => d != null);

      // Empty table — return a well-shaped empty payload so the
      // frontend's empty state renders without extra round-trips.
      if (availableDates.length === 0) {
        const empty: SpotGexHistoryResponse = {
          date: null,
          timestamp: null,
          series: [],
          availableDates: [],
        };
        setCacheHeaders(res, isMarketOpen() ? 30 : 300, 60);
        return res.status(200).json(empty);
      }

      // ── 2. Resolve the target date ──────────────────────────────
      // Default to the most recent date with data (first entry of
      // the DESC-sorted list). A supplied `date` is trusted as-is —
      // even if it isn't in availableDates the frontend's empty
      // state handles the zero-row case gracefully.
      const date = parsed.data.date ?? availableDates[0]!;

      // ── 3. Fetch the intraday series for the resolved date ──────
      // `gamma_oi` is the signed OI gamma (per 1% move) — the same
      // settlement-attractor metric analyze-context uses to classify
      // regime. Stored as NUMERIC, so it arrives as a string from the
      // Neon serverless driver.
      const seriesRows = (await sql`
        SELECT timestamp, gamma_oi AS net_gex, price AS spot
        FROM spot_exposures
        WHERE date = ${date} AND ticker = ${TICKER}
        ORDER BY timestamp ASC
      `) as Array<{
        timestamp: string | Date;
        net_gex: string | number | null;
        spot: string | number | null;
      }>;

      const series: SpotGexPoint[] = seriesRows
        .map((r) => {
          const ts = toIso(r.timestamp);
          if (ts == null) return null;
          return {
            ts,
            netGex: Number(r.net_gex ?? 0),
            spot: Number(r.spot ?? 0),
          };
        })
        .filter((p): p is SpotGexPoint => p != null);

      const timestamp = series.length > 0 ? series.at(-1)!.ts : null;

      const response: SpotGexHistoryResponse = {
        date,
        timestamp,
        series,
        availableDates,
      };

      setCacheHeaders(res, isMarketOpen() ? 30 : 300, 60);
      return res.status(200).json(response);
    } catch (err) {
      Sentry.captureException(err);
      logger.error({ err }, 'spot-gex-history fetch error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
