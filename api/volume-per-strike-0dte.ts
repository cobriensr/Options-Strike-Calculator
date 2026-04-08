/**
 * GET /api/volume-per-strike-0dte
 *
 * Returns the last 21 1-min snapshots of per-strike 0DTE raw volume from
 * volume_per_strike_0dte, so the client can compute 5-min Δ, 20-min trend,
 * and top-5 magnet rankings for the VolumePerStrike component.
 *
 * This is the read-side counterpart to the fetch-vol-0dte cron. The cron
 * pulls raw per-contract volume from UW's /option-contracts endpoint
 * (strict 0DTE via `expiry` param), aggregates per strike, and stores into
 * volume_per_strike_0dte every minute during market hours. This endpoint
 * just reads back the latest rolling window.
 *
 * Owner-gated — volume flow data derives from UW API (OPRA compliance).
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
  call_volume: string;
  put_volume: string;
  call_oi: string;
  put_oi: string;
}

interface StrikePayload {
  strike: number;
  callVolume: number;
  putVolume: number;
  callOi: number;
  putOi: number;
}

interface SnapshotPayload {
  timestamp: string;
  strikes: StrikePayload[];
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/volume-per-strike-0dte');

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
        FROM volume_per_strike_0dte
        WHERE date = ${date}
      `;

      const latestTs = tsRows[0]?.latest_ts;
      if (!latestTs) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({ snapshots: [], date });
      }

      // Fetch all rows within the last 21 minutes of the latest snapshot.
      // Ordering matters — the client expects snapshots oldest → newest,
      // and strikes sorted ascending within each snapshot.
      const rows = (await sql`
        SELECT timestamp, strike,
               call_volume, put_volume,
               call_oi, put_oi
        FROM volume_per_strike_0dte
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
          strikes: rowsForTs.map((r) => ({
            strike: n(r.strike),
            callVolume: n(r.call_volume),
            putVolume: n(r.put_volume),
            callOi: n(r.call_oi),
            putOi: n(r.put_oi),
          })),
        }));

      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ snapshots, date });
    } catch (err) {
      Sentry.captureException(err);
      logger.error({ err }, 'volume-per-strike-0dte fetch error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
