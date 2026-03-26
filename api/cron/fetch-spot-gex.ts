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
import logger from '../_lib/logger.js';

const UW_BASE = 'https://api.unusualwhales.com/api';

// ── Market hours check ──────────────────────────────────────

function isMarketHours(): boolean {
  const now = new Date();
  const et = new Date(
    now.toLocaleString('en-US', { timeZone: 'America/New_York' }),
  );
  const day = et.getDay();
  if (day === 0 || day === 6) return false;

  const hour = et.getHours();
  const minute = et.getMinutes();
  const timeMinutes = hour * 60 + minute;

  return timeMinutes >= 565 && timeMinutes <= 965;
}

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
  const res = await fetch(`${UW_BASE}/stock/SPX/spot-exposures`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`UW API ${res.status}: ${text.slice(0, 200)}`);
  }

  const body = await res.json();
  return body.data ?? [];
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
    const minutes = dt.getMinutes();
    const rounded = new Date(dt);
    rounded.setMinutes(minutes - (minutes % 5), 0, 0);
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
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!isMarketHours()) {
    return res
      .status(200)
      .json({ skipped: true, reason: 'Outside market hours' });
  }

  const apiKey = process.env.UW_API_KEY;
  if (!apiKey) {
    logger.error('UW_API_KEY not configured');
    return res.status(500).json({ error: 'UW_API_KEY not configured' });
  }

  try {
    const rows = await fetchSpotExposures(apiKey);
    const result = await storeLatest(rows);

    logger.info({ ticks: rows.length, ...result }, 'fetch-spot-gex completed');

    return res.status(200).json({ ticks: rows.length, ...result });
  } catch (err) {
    logger.error({ err }, 'fetch-spot-gex error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
