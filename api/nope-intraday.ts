/**
 * GET /api/nope-intraday
 *
 * Returns per-minute SPY NOPE points for one trading date, suitable for
 * overlay on the GexTarget PriceChart.
 *
 * Modes:
 *   - `GET /api/nope-intraday`               → latest date with rows in nope_ticks
 *   - `GET /api/nope-intraday?date=YYYY-MM-DD` → that specific ET date
 *
 * Owner-gated. SPY-only (the cron only fetches SPY because SPX has no
 * tradeable underlying — the NOPE denominator would be undefined).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from './_lib/db.js';
import { Sentry } from './_lib/sentry.js';
import { rejectIfNotOwner, checkBot } from './_lib/api-helpers.js';
import logger from './_lib/logger.js';

const TICKER = 'SPY';

export interface NopePoint {
  timestamp: string;
  nope: number;
  nope_fill: number;
}

export interface NopeIntradayResponse {
  ticker: string;
  date: string | null;
  availableDates: string[];
  points: NopePoint[];
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const str = String(value);
  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime()) ? str : parsed.toISOString();
}

function toDateString(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const str = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  return null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/nope-intraday');

    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'GET only' });
    }

    const botCheck = await checkBot(req);
    if (botCheck.isBot) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (rejectIfNotOwner(req, res)) return;

    const dateParam = req.query.date as string | undefined;
    if (dateParam !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(400).json({ error: 'Invalid date' });
    }

    try {
      const sql = getDb();

      // Distinct ET dates that have any rows. Drives both date resolution
      // and a small client-side date picker if you ever add one.
      const dateRows = (await sql`
        SELECT DISTINCT (timestamp AT TIME ZONE 'America/New_York')::date AS d
        FROM nope_ticks
        WHERE ticker = ${TICKER}
        ORDER BY d ASC
      `) as Array<{ d: string | Date }>;

      const availableDates = dateRows
        .map((r) => toDateString(r.d))
        .filter((d): d is string => d != null);

      if (availableDates.length === 0) {
        const empty: NopeIntradayResponse = {
          ticker: TICKER,
          date: null,
          availableDates: [],
          points: [],
        };
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json(empty);
      }

      const date = dateParam ?? availableDates.at(-1)!;

      const pointRows = (await sql`
        SELECT timestamp, nope, nope_fill
        FROM nope_ticks
        WHERE ticker = ${TICKER}
          AND (timestamp AT TIME ZONE 'America/New_York')::date = ${date}
        ORDER BY timestamp ASC
      `) as Array<{
        timestamp: string | Date;
        nope: string | number;
        nope_fill: string | number;
      }>;

      const points: NopePoint[] = pointRows
        .map((r) => {
          const ts = toIso(r.timestamp);
          if (ts == null) return null;
          return {
            timestamp: ts,
            nope: Number(r.nope),
            nope_fill: Number(r.nope_fill),
          };
        })
        .filter((p): p is NopePoint => p != null);

      const response: NopeIntradayResponse = {
        ticker: TICKER,
        date,
        availableDates,
        points,
      };
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(response);
    } catch (err) {
      Sentry.captureException(err);
      logger.error({ err }, 'nope-intraday fetch error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
