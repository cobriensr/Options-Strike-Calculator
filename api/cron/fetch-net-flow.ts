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
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import {
  cronGuard,
  uwFetch,
  roundTo5Min,
  withRetry,
  checkDataQuality,
} from '../_lib/api-helpers.js';

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
  const ticks = await uwFetch<NetPremTick>(
    apiKey,
    `/stock/${ticker}/net-prem-ticks`,
  );

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
    const rounded = roundTo5Min(new Date(tick.timestamp));
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

async function storeAllCandles(
  candles: CumulatedTick[],
  source: string,
): Promise<{ stored: number; skipped: number }> {
  if (candles.length === 0) return { stored: 0, skipped: 0 };

  const sql = getDb();
  let stored = 0;
  let skipped = 0;

  for (const candle of candles) {
    const result = await sql`
      INSERT INTO flow_data (date, timestamp, source, ncp, npp, net_volume)
      VALUES (
        ${candle.date},
        ${candle.timestamp},
        ${source},
        ${candle.ncp},
        ${candle.npp},
        ${candle.netVolume}
      )
      ON CONFLICT (date, timestamp, source) DO NOTHING
      RETURNING id
    `;
    if (result.length > 0) stored++;
    else skipped++;
  }

  return { stored, skipped };
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res);
  if (!guard) return;
  const { apiKey, today } = guard;

  const startTime = Date.now();

  try {
    const results: Record<
      string,
      { stored: number; skipped: number; candles: number }
    > = {};

    // Fetch all tickers sequentially to respect UW concurrency limit
    for (const { ticker, source } of TICKERS) {
      try {
        const candles = await withRetry(() => fetchNetFlow(apiKey, ticker));
        const result = await storeAllCandles(candles, source);
        results[source] = { ...result, candles: candles.length };
      } catch (err) {
        logger.warn({ err, ticker, source }, 'Failed to fetch net flow');
        results[source] = { stored: 0, skipped: 0, candles: 0 };
      }
    }

    // Data quality check: alert if all values are zero per source
    for (const { source } of TICKERS) {
      const rows = await getDb()`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE ncp::numeric != 0 OR npp::numeric != 0) AS nonzero
        FROM flow_data
        WHERE date = ${today} AND source = ${source}
      `;
      const { total, nonzero } = rows[0]!;
      await checkDataQuality({
        job: 'fetch-net-flow',
        table: 'flow_data',
        date: today,
        sourceFilter: source,
        total: Number(total),
        nonzero: Number(nonzero),
      });
    }

    logger.info({ results }, 'fetch-net-flow completed');

    return res.status(200).json({
      job: 'fetch-net-flow',
      stored: true,
      results,
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-net-flow');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-net-flow error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
