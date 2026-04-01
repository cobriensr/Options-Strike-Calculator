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
 * Samples to 5-minute intervals for consistency with other crons.
 * Stores in spot_exposures table.
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
  roundTo5Min,
  cronGuard,
  checkDataQuality,
  withRetry,
} from '../_lib/api-helpers.js';

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

// ── Sample to 5-min + store latest ──────────────────────────

async function storeLatest(
  rows: SpotExposureRow[],
): Promise<{ stored: boolean; timestamp?: string }> {
  if (rows.length === 0) return { stored: false };

  // Sample to 5-min intervals, take last tick per window
  const sampled = new Map<string, SpotExposureRow>();
  for (const row of rows) {
    const dt = new Date(row.start_time ?? row.time);
    const rounded = roundTo5Min(dt);
    sampled.set(rounded.toISOString(), row);
  }

  // Get the most recent 5-min candle
  const keys = Array.from(sampled.keys()).sort((a, b) => a.localeCompare(b));
  const latestKey = keys.at(-1)!;
  const latest = sampled.get(latestKey)!;

  const date = new Date(latest.start_time ?? latest.time).toLocaleDateString(
    'en-CA',
    { timeZone: 'America/New_York' },
  );

  const sql = getDb();
  await sql`
    INSERT INTO spot_exposures (
      date, timestamp, ticker, price,
      gamma_oi, gamma_vol, gamma_dir,
      charm_oi, charm_vol, charm_dir,
      vanna_oi, vanna_vol, vanna_dir
    )
    VALUES (
      ${date}, ${latestKey}, 'SPX', ${latest.price},
      ${latest.gamma_per_one_percent_move_oi},
      ${latest.gamma_per_one_percent_move_vol},
      ${latest.gamma_per_one_percent_move_dir},
      ${latest.charm_per_one_percent_move_oi},
      ${latest.charm_per_one_percent_move_vol},
      ${latest.charm_per_one_percent_move_dir},
      ${latest.vanna_per_one_percent_move_oi},
      ${latest.vanna_per_one_percent_move_vol},
      ${latest.vanna_per_one_percent_move_dir}
    )
    ON CONFLICT (date, timestamp, ticker) DO NOTHING
  `;

  return { stored: true, timestamp: latestKey };
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res);
  if (!guard) return;
  const { apiKey, today } = guard;

  const startTime = Date.now();

  try {
    const rows = await withRetry(() => fetchSpotExposures(apiKey));
    const result = await withRetry(() => storeLatest(rows));

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
