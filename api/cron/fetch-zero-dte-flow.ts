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
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import {
  cronGuard,
  uwFetch,
  roundTo5Min,
  withRetry,
  checkDataQuality,
} from '../_lib/api-helpers.js';

const SOURCE = 'zero_dte_index';

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
  // Omit date param for current-day fetches — the UW API returns
  // null values when ?date= is the current trading day. Without it,
  // the API returns the live cumulative intraday series. The backfill
  // script passes ?date= for historical dates where it works correctly.
  return uwFetch<FlowTick>(
    apiKey,
    '/net-flow/expiry?expiration=zero_dte&tide_type=index_only',
    (body) => {
      // Nested structure: data[0].data[] contains the ticks
      const outer = (body.data as Array<{ data?: FlowTick[] }>) ?? [];
      if (outer.length === 0) return [];
      return outer[0]?.data ?? [];
    },
  );
}

// ── Sample to 5-min + store ─────────────────────────────────

async function storeLatest(
  ticks: FlowTick[],
): Promise<{ stored: number; skipped: number }> {
  if (ticks.length === 0) return { stored: 0, skipped: 0 };

  // Sample to 5-min intervals, keep last tick per window
  const sampled = new Map<string, FlowTick>();
  for (const tick of ticks) {
    const rounded = roundTo5Min(new Date(tick.timestamp));
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
  const guard = cronGuard(req, res);
  if (!guard) return;
  const { apiKey, today } = guard;

  const startTime = Date.now();

  try {
    const ticks = await withRetry(() => fetchZeroDteFlow(apiKey));
    const result = await withRetry(() => storeLatest(ticks));

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

    // Data quality check: alert if all values are null/zero
    if (result.stored > 10) {
      const rows = await getDb()`
        SELECT COUNT(*) AS total,
               COUNT(ncp) AS non_null
        FROM flow_data
        WHERE date = ${today} AND source = ${SOURCE}
      `;
      const { total, non_null } = rows[0]!;
      await checkDataQuality({
        job: 'fetch-zero-dte-flow',
        table: 'flow_data',
        date: today,
        sourceFilter: SOURCE,
        total: Number(total),
        nonzero: Number(non_null),
      });
    }

    return res.status(200).json({
      job: 'fetch-zero-dte-flow',
      ticks: ticks.length,
      ...result,
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-zero-dte-flow');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-zero-dte-flow error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
