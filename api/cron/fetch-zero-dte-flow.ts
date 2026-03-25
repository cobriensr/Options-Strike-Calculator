/**
 * GET /api/cron/fetch-zero-dte-flow
 *
 * Fetches 0DTE index-only net flow from Unusual Whales Net Flow Expiry endpoint.
 * Filters: expiration=zero_dte, tide_type=index_only
 *
 * This isolates flow from options expiring TODAY on index products (SPX, NDX, etc.)
 * from weekly/monthly flow. When aggregate SPX Net Flow shows bearish but 0DTE
 * index flow is neutral, the bearishness is from longer-dated hedging, not today's session.
 *
 * Data is already cumulative (same as Market Tide). Sampled to 5-min intervals.
 * Stored in flow_data table with source = 'zero_dte_index'.
 *
 * Total API calls per invocation: 1
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';

const UW_BASE = 'https://api.unusualwhales.com/api';
const SOURCE = 'zero_dte_index';

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

interface FlowTick {
  timestamp: string;
  date: string;
  net_call_premium: string;
  net_put_premium: string;
  net_volume: string;
  underlying_price: string;
}

// ── Fetch helper ────────────────────────────────────────────

async function fetchZeroDteFlow(apiKey: string): Promise<FlowTick[]> {
  const params = new URLSearchParams({
    expiration: 'zero_dte',
    tide_type: 'index_only',
  });

  const res = await fetch(`${UW_BASE}/net-flow/expiry?${params}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`UW API ${res.status}: ${text.slice(0, 200)}`);
  }

  const body = await res.json();
  // Nested structure: data[0].data[] contains the ticks
  const outerData = body.data ?? [];
  if (outerData.length === 0) return [];
  return outerData[0]?.data ?? [];
}

// ── Sample to 5-min + store ─────────────────────────────────

async function storeLatest(
  ticks: FlowTick[],
): Promise<{ stored: number; skipped: number }> {
  if (ticks.length === 0) return { stored: 0, skipped: 0 };

  // Sample to 5-min intervals, keep last tick per window
  const sampled = new Map<string, FlowTick>();
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
      const result = await sql`
        INSERT INTO flow_data (date, timestamp, source, ncp, npp, net_volume)
        VALUES (
          ${tick.date}, ${ts}, ${SOURCE},
          ${tick.net_call_premium}, ${tick.net_put_premium}, ${tick.net_volume}
        )
        ON CONFLICT (date, timestamp, source) DO NOTHING
        RETURNING id
      `;
      if (result.length > 0) stored++;
      else skipped++;
    } catch (err) {
      logger.warn({ err, ts }, '0DTE flow insert failed');
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
  const authHeader = req.headers.authorization;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
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
    const ticks = await fetchZeroDteFlow(apiKey);
    const result = await storeLatest(ticks);

    // Log latest values
    const latest = ticks.at(-1);
    logger.info(
      {
        totalTicks: ticks.length,
        ...result,
        latestNcp: latest?.net_call_premium,
        latestNpp: latest?.net_put_premium,
      },
      'fetch-zero-dte-flow completed',
    );

    return res.status(200).json({
      ticks: ticks.length,
      ...result,
    });
  } catch (err) {
    logger.error({ err }, 'fetch-zero-dte-flow error');
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Fetch failed',
    });
  }
}
