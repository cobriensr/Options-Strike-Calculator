/**
 * GET /api/cron/fetch-spot-gex
 *
 * Fetches SPX Spot GEX exposures (per 1-minute) from Unusual Whales API.
 * This is the Aggregate GEX panel as a time series — includes:
 *   - OI Net Gamma (Rule 16 regime)
 *   - Volume Net Gamma (intraday trading gamma)
 *   - Directionalized Volume Net Gamma (intent-weighted)
 *   - Plus charm and vanna equivalents
 *   - SPX price at each timestamp
 *
 * Writes all 1-minute ticks newer than the high-water-mark for today in
 * `spot_exposures`. Designed to run every minute during RTH (matches the
 * FuturesGammaPlaybook regime-monitor cadence) so the UI sees fresh dealer
 * positioning within 60 s. A single missed run auto-backfills on the next
 * invocation because UW returns the full session history and we diff
 * against the HWM before inserting. `ON CONFLICT DO NOTHING` on
 * (date, timestamp, ticker) is the belt-and-braces dedup.
 *
 * Total API calls per invocation: 1
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import {
  uwFetch,
  cronGuard,
  checkDataQuality,
  withRetry,
} from '../_lib/api-helpers.js';
import { reportCronRun } from '../_lib/axiom.js';
import { getETDateStr } from '../../src/utils/timezone.js';

// ── Types ───────────────────────────────────────────────────

interface SpotExposureRow {
  time: string;
  start_time?: string;
  price: string;
  gamma_per_one_percent_move_oi: string;
  gamma_per_one_percent_move_vol: string;
  gamma_per_one_percent_move_dir: string;
  charm_per_one_percent_move_oi: string;
  charm_per_one_percent_move_vol: string;
  charm_per_one_percent_move_dir: string;
  vanna_per_one_percent_move_oi: string;
  vanna_per_one_percent_move_vol: string;
  vanna_per_one_percent_move_dir: string;
}

// ── Fetch helper ────────────────────────────────────────────

async function fetchSpotExposures(apiKey: string): Promise<SpotExposureRow[]> {
  return uwFetch<SpotExposureRow>(apiKey, '/stock/SPX/spot-exposures');
}

// ── Bulk insert rows newer than the DB high-water-mark ──────
//
// UW returns today's full session history on every call. We query the
// latest timestamp we already have for today, filter UW rows to only the
// ones past that mark, and insert them. On a steady-state run this is
// usually 1 row; after a missed cron it catches up all the gap rows.

async function storeNewRows(
  rows: SpotExposureRow[],
  today: string,
): Promise<{ stored: number; timestamp?: string }> {
  if (rows.length === 0) return { stored: 0 };

  const sql = getDb();
  const hwmRows = (await sql`
    SELECT MAX(timestamp) AS max_ts
    FROM spot_exposures
    WHERE date = ${today} AND ticker = 'SPX'
  `) as Array<{ max_ts: string | Date | null }>;
  const rawMax = hwmRows[0]?.max_ts ?? null;
  const hwmIso =
    rawMax === null
      ? null
      : rawMax instanceof Date
        ? rawMax.toISOString()
        : new Date(rawMax).toISOString();

  const toInsert = rows
    .map((r) => ({
      row: r,
      tsIso: new Date(r.start_time ?? r.time).toISOString(),
    }))
    .filter(({ tsIso }) => hwmIso === null || tsIso > hwmIso)
    .sort((a, b) => a.tsIso.localeCompare(b.tsIso));

  if (toInsert.length === 0) return { stored: 0 };

  for (const { row, tsIso } of toInsert) {
    const rowDate = getETDateStr(new Date(row.start_time ?? row.time));
    await sql`
      INSERT INTO spot_exposures (
        date, timestamp, ticker, price,
        gamma_oi, gamma_vol, gamma_dir,
        charm_oi, charm_vol, charm_dir,
        vanna_oi, vanna_vol, vanna_dir
      )
      VALUES (
        ${rowDate}, ${tsIso}, 'SPX', ${row.price},
        ${row.gamma_per_one_percent_move_oi},
        ${row.gamma_per_one_percent_move_vol},
        ${row.gamma_per_one_percent_move_dir},
        ${row.charm_per_one_percent_move_oi},
        ${row.charm_per_one_percent_move_vol},
        ${row.charm_per_one_percent_move_dir},
        ${row.vanna_per_one_percent_move_oi},
        ${row.vanna_per_one_percent_move_vol},
        ${row.vanna_per_one_percent_move_dir}
      )
      ON CONFLICT (date, timestamp, ticker) DO NOTHING
    `;
  }

  return { stored: toInsert.length, timestamp: toInsert.at(-1)!.tsIso };
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res);
  if (!guard) return;
  const { apiKey, today } = guard;

  const startTime = Date.now();

  try {
    const rows = await withRetry(() => fetchSpotExposures(apiKey));
    const result = await withRetry(() => storeNewRows(rows, today));

    // Data quality check: alert if all gamma_oi values are null/zero
    const qcRows = await getDb()`
      SELECT COUNT(*) AS total,
             COUNT(*) FILTER (WHERE gamma_oi::numeric != 0) AS nonzero
      FROM spot_exposures
      WHERE date = ${today} AND ticker = 'SPX'
    `;
    const { total, nonzero } = qcRows[0]!;
    await checkDataQuality({
      job: 'fetch-spot-gex',
      table: 'spot_exposures',
      date: today,
      total: Number(total),
      nonzero: Number(nonzero),
    });

    logger.info({ ticks: rows.length, ...result }, 'fetch-spot-gex completed');

    await reportCronRun('fetch-spot-gex', {
      status: 'ok',
      ticks: rows.length,
      stored: result.stored,
      totalRows: Number(total),
      nonzeroRows: Number(nonzero),
      durationMs: Date.now() - startTime,
    });

    return res.status(200).json({
      job: 'fetch-spot-gex',
      ticks: rows.length,
      ...result,
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-spot-gex');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-spot-gex error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
