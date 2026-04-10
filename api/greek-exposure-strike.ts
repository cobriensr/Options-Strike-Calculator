/**
 * GET /api/greek-exposure-strike
 *
 * Returns SPX per-strike greek exposure for a given date and expiry.
 * Data is populated by the backfill-greek-exposure-strike script.
 * For 0DTE, date=expiry=<trading_date>.
 *
 * Query params:
 *   ?date=YYYY-MM-DD    — trading date (default: today ET)
 *   ?expiry=YYYY-MM-DD  — expiry date (default: date value, since 0DTE date=expiry)
 *
 * Owner-gated — Greek exposure derives from UW API (OPRA compliance).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from './_lib/db.js';
import { Sentry } from './_lib/sentry.js';
import { rejectIfNotOwner, checkBot } from './_lib/api-helpers.js';
import logger from './_lib/logger.js';

// ── Types ───────────────────────────────────────────────────

interface StrikeGreekExposure {
  strike: number;
  dte: number;
  // Layer 1 raw
  callGex: number | null;
  putGex: number | null;
  callDelta: number | null;
  putDelta: number | null;
  callCharm: number | null;
  putCharm: number | null;
  callVanna: number | null;
  putVanna: number | null;
  // Layer 2 computed
  netGex: number | null;
  netDelta: number | null;
  netCharm: number | null;
  netVanna: number | null;
  absGex: number | null;
  callGexFraction: number | null;
}

interface GreekExposureStrikeResponse {
  date: string;
  expiry: string;
  strikes: StrikeGreekExposure[];
}

// ── Helpers ─────────────────────────────────────────────────

function getTodayET(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(
    new Date(),
  );
}

function parseNum(val: unknown): number | null {
  if (val == null) return null;
  const n = Number(val);
  return Number.isNaN(n) ? null : n;
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/greek-exposure-strike');

    try {
      if (req.method !== 'GET') {
        return res.status(405).json({ error: 'GET only' });
      }

      const botCheck = await checkBot(req);
      if (botCheck.isBot) {
        return res.status(403).json({ error: 'Access denied' });
      }

      if (rejectIfNotOwner(req, res)) return;

      const sql = getDb();

      const dateParam = req.query.date as string | undefined;
      const date =
        dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
          ? dateParam
          : getTodayET();

      const expiryParam = req.query.expiry as string | undefined;
      const expiry =
        expiryParam && /^\d{4}-\d{2}-\d{2}$/.test(expiryParam)
          ? expiryParam
          : date;

      const rows = await sql`
        SELECT
          strike, dte,
          call_gex, put_gex,
          call_delta, put_delta,
          call_charm, put_charm,
          call_vanna, put_vanna,
          net_gex, net_delta, net_charm, net_vanna,
          abs_gex, call_gex_fraction
        FROM greek_exposure_strike
        WHERE date = ${date} AND expiry = ${expiry}
        ORDER BY strike ASC
      `;

      const strikes: StrikeGreekExposure[] = rows.map((r) => ({
        strike: Number(r.strike),
        dte: Number(r.dte),
        callGex: parseNum(r.call_gex),
        putGex: parseNum(r.put_gex),
        callDelta: parseNum(r.call_delta),
        putDelta: parseNum(r.put_delta),
        callCharm: parseNum(r.call_charm),
        putCharm: parseNum(r.put_charm),
        callVanna: parseNum(r.call_vanna),
        putVanna: parseNum(r.put_vanna),
        netGex: parseNum(r.net_gex),
        netDelta: parseNum(r.net_delta),
        netCharm: parseNum(r.net_charm),
        netVanna: parseNum(r.net_vanna),
        absGex: parseNum(r.abs_gex),
        callGexFraction: parseNum(r.call_gex_fraction),
      }));

      const response: GreekExposureStrikeResponse = { date, expiry, strikes };

      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(response);
    } catch (err) {
      Sentry.captureException(err);
      logger.error({ err }, 'greek-exposure-strike fetch error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
