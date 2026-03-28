/**
 * GET /api/cron/fetch-net-flow
 *
 * Fetches net premium ticks from Unusual Whales API for SPX, SPY, and QQQ.
 * Designed to run every 5 minutes during market hours via Vercel Cron.
 *
 * IMPORTANT: The UW net-prem-ticks API returns per-minute INCREMENTAL data.
 * This endpoint cumulates the ticks and samples at 5-minute intervals to
 * produce the same NCP/NPP values visible on the Net Flow charts.
 *
 * Stores in the same flow_data table as Market Tide with source names:
 *   'spx_flow', 'spy_flow', 'qqq_flow'
 *
 * Total API calls per invocation: 3 (one per ticker)
 *
 * Environment: UW_API_KEY, CRON_SECRET (for Vercel cron auth)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { TIMEOUTS } from '../_lib/constants.js';
import logger from '../_lib/logger.js';
import { isMarketHours } from '../_lib/api-helpers.js';

const UW_BASE = 'https://api.unusualwhales.com/api';

const TICKERS: Array<{ ticker: string; source: string }> = [
  { ticker: 'SPX', source: 'spx_flow' },
  { ticker: 'SPY', source: 'spy_flow' },
  { ticker: 'QQQ', source: 'qqq_flow' },
];

// ── Types ───────────────────────────────────────────────────

interface NetPremTick {
  date: string;
  tape_time: string;
  net_call_premium: string;
  net_put_premium: string;
  net_call_volume: number;
  net_put_volume: number;
  net_delta: string;
  call_volume: number;
  put_volume: number;
}

interface CumulatedTick {
  date: string;
  timestamp: string;
  ncp: number;
  npp: number;
  netVolume: number;
}

// ── Fetch + cumulate + sample ───────────────────────────────

async function fetchNetFlow(
  apiKey: string,
  ticker: string,
): Promise<CumulatedTick[]> {
  const res = await fetch(`${UW_BASE}/stock/${ticker}/net-prem-ticks`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(TIMEOUTS.UW_API),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `UW API ${res.status} for ${ticker}: ${text.slice(0, 200)}`,
    );
  }

  const body = await res.json();
  const ticks: NetPremTick[] = body.data ?? [];

  if (ticks.length === 0) return [];

  // Step 1: Cumulate the incremental ticks
  const cumulated: Array<{
    date: string;
    timestamp: string;
    ncp: number;
    npp: number;
    netCallVol: number;
    netPutVol: number;
  }> = [];

  let runningNcp = 0;
  let runningNpp = 0;
  let runningCallVol = 0;
  let runningPutVol = 0;

  for (const tick of ticks) {
    runningNcp += Number.parseFloat(tick.net_call_premium) || 0;
    runningNpp += Number.parseFloat(tick.net_put_premium) || 0;
    runningCallVol += tick.net_call_volume || 0;
    runningPutVol += tick.net_put_volume || 0;

    cumulated.push({
      date: tick.date,
      timestamp: tick.tape_time,
      ncp: runningNcp,
      npp: runningNpp,
      netCallVol: runningCallVol,
      netPutVol: runningPutVol,
    });
  }

  // Step 2: Sample at 5-minute intervals (take the last tick in each 5-min window)
  const sampled = new Map<string, CumulatedTick>();

  for (const tick of cumulated) {
    const dt = new Date(tick.timestamp);
    // Round down to nearest 5-minute boundary
    const minutes = dt.getMinutes();
    const rounded = new Date(dt);
    rounded.setMinutes(minutes - (minutes % 5), 0, 0);
    const key = rounded.toISOString();

    // Keep the latest tick in each 5-min window (overwrites earlier ones)
    sampled.set(key, {
      date: tick.date,
      timestamp: key,
      ncp: tick.ncp,
      npp: tick.npp,
      netVolume: tick.netCallVol + tick.netPutVol,
    });
  }

  return Array.from(sampled.values()).sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
}

// ── Store helper ────────────────────────────────────────────

async function storeLatestCandle(
  candles: CumulatedTick[],
  source: string,
): Promise<{ stored: boolean; timestamp?: string }> {
  if (candles.length === 0) return { stored: false };

  const latest = candles.at(-1)!;
  const sql = getDb();

  await sql`
    INSERT INTO flow_data (date, timestamp, source, ncp, npp, net_volume)
    VALUES (
      ${latest.date},
      ${latest.timestamp},
      ${source},
      ${latest.ncp},
      ${latest.npp},
      ${latest.netVolume}
    )
    ON CONFLICT (date, timestamp, source) DO NOTHING
  `;

  return { stored: true, timestamp: latest.timestamp };
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }

  // Verify cron secret
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
    const results: Record<string, { stored: boolean; timestamp?: string }> = {};

    // Fetch all tickers in parallel
    const fetches = await Promise.all(
      TICKERS.map(async ({ ticker, source }) => {
        try {
          const candles = await fetchNetFlow(apiKey, ticker);
          const result = await storeLatestCandle(candles, source);
          return { source, result, candleCount: candles.length };
        } catch (err) {
          logger.warn({ err, ticker, source }, 'Failed to fetch net flow');
          return { source, result: { stored: false }, candleCount: 0 };
        }
      }),
    );

    for (const f of fetches) {
      results[f.source] = f.result;
    }

    logger.info({ results }, 'fetch-net-flow completed');

    return res.status(200).json({ stored: true, results });
  } catch (err) {
    logger.error({ err }, 'fetch-net-flow error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
