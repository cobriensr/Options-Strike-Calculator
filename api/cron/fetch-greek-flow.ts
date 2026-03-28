/**
 * GET /api/cron/fetch-greek-flow
 *
 * Fetches 0DTE-specific delta and vega flow for SPX from Unusual Whales API.
 * Uses the Greek Flow by Expiry endpoint filtered to today's expiration.
 *
 * Delta flow = how much directional exposure is being added per minute.
 * Vega flow = how much volatility exposure is being added per minute.
 *
 * When delta flow surges negative while premium flow (NCP) is flat,
 * institutions are adding directional delta without paying premium — likely
 * through complex structures (spreads, combos) rather than outright buys.
 * This is a higher-conviction directional signal than premium alone.
 *
 * Stored in flow_data table with source = 'zero_dte_greek_flow'.
 * ncp column = total_delta_flow, npp column = dir_delta_flow,
 * net_volume column = volume.
 *
 * Total API calls per invocation: 1
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { TIMEOUTS } from '../_lib/constants.js';
import logger from '../_lib/logger.js';

const UW_BASE = 'https://api.unusualwhales.com/api';
const SOURCE = 'zero_dte_greek_flow';

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

function getTodayET(): string {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  });
}

// ── Types ───────────────────────────────────────────────────

interface GreekFlowTick {
  timestamp: string;
  ticker: string;
  expiry?: string;
  total_delta_flow: string;
  dir_delta_flow: string;
  total_vega_flow: string;
  dir_vega_flow: string;
  otm_total_delta_flow: string;
  otm_dir_delta_flow: string;
  otm_total_vega_flow: string;
  otm_dir_vega_flow: string;
  transactions: number;
  volume: number;
}

// ── Fetch helper ────────────────────────────────────────────

async function fetchGreekFlow(
  apiKey: string,
  today: string,
): Promise<GreekFlowTick[]> {
  const res = await fetch(`${UW_BASE}/stock/SPX/greek-flow/${today}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(TIMEOUTS.UW_API),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`UW API ${res.status}: ${text.slice(0, 200)}`);
  }

  const body = await res.json();
  return body.data ?? [];
}

// ── Sample to 5-min + store ─────────────────────────────────

async function storeLatest(
  ticks: GreekFlowTick[],
  today: string,
): Promise<{ stored: number; skipped: number }> {
  if (ticks.length === 0) return { stored: 0, skipped: 0 };

  // Sample to 5-min intervals, keep last tick per window
  const sampled = new Map<string, GreekFlowTick>();
  for (const tick of ticks) {
    const dt = new Date(tick.timestamp);
    const minutes = dt.getMinutes();
    const rounded = new Date(dt);
    rounded.setMinutes(minutes - (minutes % 5), 0, 0);
    sampled.set(rounded.toISOString(), tick);
  }

  const sql = getDb();
  let stored = 0;
  let skipped = 0;

  for (const [ts, tick] of sampled) {
    try {
      // Store delta flow in ncp/npp columns for compatibility with flow_data table
      // ncp = total_delta_flow, npp = dir_delta_flow, net_volume = volume
      const result = await sql`
        INSERT INTO flow_data (date, timestamp, source, ncp, npp, net_volume)
        VALUES (
          ${today}, ${ts}, ${SOURCE},
          ${tick.total_delta_flow}, ${tick.dir_delta_flow}, ${tick.volume}
        )
        ON CONFLICT (date, timestamp, source) DO NOTHING
        RETURNING id
      `;
      if (result.length > 0) stored++;
      else skipped++;
    } catch (err) {
      logger.warn({ err, ts }, 'Greek flow insert failed');
      skipped++;
    }
  }

  return { stored, skipped };
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

  const today = getTodayET();

  try {
    const ticks = await fetchGreekFlow(apiKey, today);
    const result = await storeLatest(ticks, today);

    const latest = ticks.at(-1);
    logger.info(
      {
        totalTicks: ticks.length,
        ...result,
        latestDelta: latest?.total_delta_flow,
        latestDirDelta: latest?.dir_delta_flow,
      },
      'fetch-greek-flow completed',
    );

    return res.status(200).json({
      ticks: ticks.length,
      ...result,
    });
  } catch (err) {
    logger.error({ err }, 'fetch-greek-flow error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
