/**
 * GET /api/gex-migration-0dte
 *
 * Returns the last 21 1-min snapshots of per-strike 0DTE GEX from
 * gex_strike_0dte, so the client can compute 5-min Δ, 20-min trend,
 * urgency leaderboard, centroid drift, and sparklines for the GEX
 * migration component.
 *
 * The client picks the GEX mode (OI / VOL / DIR) at render time and
 * recomputes migration without re-fetching — so this endpoint always
 * returns raw per-strike gamma components for all three modes.
 *
 * Owner-gated — Greek exposure derives from UW API (OPRA compliance).
 * Frontend polls this every 60 seconds while marketOpen.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from './_lib/db.js';
import { Sentry } from './_lib/sentry.js';
import { rejectIfNotOwner } from './_lib/api-helpers.js';
import logger from './_lib/logger.js';

// The `INTERVAL '21 minutes'` literal below is inlined (not interpolated)
// because Neon's tagged template would treat `${n}` as a bind parameter,
// and PostgreSQL doesn't allow parameters inside INTERVAL literals.
// 21 minutes covers the sparkline window + 20-min trend comparison.

interface SnapshotRow {
  timestamp: string;
  strike: string;
  price: string;
  call_gamma_oi: string;
  put_gamma_oi: string;
  call_gamma_vol: string;
  put_gamma_vol: string;
  call_gamma_ask: string;
  call_gamma_bid: string;
  put_gamma_ask: string;
  put_gamma_bid: string;
}

interface StrikePayload {
  strike: number;
  price: number;
  callGammaOi: number;
  putGammaOi: number;
  callGammaVol: number;
  putGammaVol: number;
  callGammaAsk: number;
  callGammaBid: number;
  putGammaAsk: number;
  putGammaBid: number;
}

interface SnapshotPayload {
  timestamp: string;
  price: number;
  strikes: StrikePayload[];
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/gex-migration-0dte');

    try {
      if (req.method !== 'GET') {
        return res.status(405).json({ error: 'GET only' });
      }

      if (rejectIfNotOwner(req, res)) return;

      const sql = getDb();

      const dateParam = req.query.date as string | undefined;
      const date =
        dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
          ? dateParam
          : new Date().toLocaleDateString('en-CA', {
              timeZone: 'America/New_York',
            });

      // Find the latest timestamp for the date
      const tsRows = await sql`
        SELECT MAX(timestamp) AS latest_ts
        FROM gex_strike_0dte
        WHERE date = ${date}
      `;

      const latestTs = tsRows[0]?.latest_ts;
      if (!latestTs) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({ snapshots: [], date });
      }

      // Fetch all rows within the last N minutes of the latest snapshot.
      // Ordering matters — the client expects snapshots oldest → newest,
      // and strikes sorted ascending within each snapshot.
      const rows = (await sql`
        SELECT timestamp, strike, price,
               call_gamma_oi, put_gamma_oi,
               call_gamma_vol, put_gamma_vol,
               call_gamma_ask, call_gamma_bid,
               put_gamma_ask, put_gamma_bid
        FROM gex_strike_0dte
        WHERE date = ${date}
          AND timestamp >= ${latestTs}::timestamptz - INTERVAL '21 minutes'
        ORDER BY timestamp ASC, strike ASC
      `) as unknown as SnapshotRow[];

      const n = (v: unknown) => Number(v) || 0;

      // Group rows by timestamp into structured snapshots
      const byTs = new Map<string, SnapshotRow[]>();
      for (const row of rows) {
        const ts = new Date(row.timestamp).toISOString();
        const bucket = byTs.get(ts);
        if (bucket) {
          bucket.push(row);
        } else {
          byTs.set(ts, [row]);
        }
      }

      const snapshots: SnapshotPayload[] = Array.from(byTs.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([timestamp, rowsForTs]) => ({
          timestamp,
          price: n(rowsForTs[0]!.price),
          strikes: rowsForTs.map((r) => ({
            strike: n(r.strike),
            price: n(r.price),
            callGammaOi: n(r.call_gamma_oi),
            putGammaOi: n(r.put_gamma_oi),
            callGammaVol: n(r.call_gamma_vol),
            putGammaVol: n(r.put_gamma_vol),
            callGammaAsk: n(r.call_gamma_ask),
            callGammaBid: n(r.call_gamma_bid),
            putGammaAsk: n(r.put_gamma_ask),
            putGammaBid: n(r.put_gamma_bid),
          })),
        }));

      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ snapshots, date });
    } catch (err) {
      Sentry.captureException(err);
      logger.error({ err }, 'gex-migration-0dte fetch error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
