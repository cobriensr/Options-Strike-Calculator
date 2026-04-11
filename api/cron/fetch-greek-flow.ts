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
 * net_volume column = volume,
 * otm_ncp column = otm_total_delta_flow, otm_npp column = otm_dir_delta_flow.
 *
 * The OTM variants capture directional conviction in the wings (informed
 * positioning), while the total/non-OTM columns include ATM activity that
 * is dominated by dealer hedging and gamma scalping. See migration #48.
 *
 * Total API calls per invocation: 1
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import {
  cronGuard,
  uwFetch,
  roundTo5Min,
  withRetry,
  checkDataQuality,
} from '../_lib/api-helpers.js';
import { reportCronRun } from '../_lib/axiom.js';

const SOURCE = 'zero_dte_greek_flow';

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
  return uwFetch<GreekFlowTick>(apiKey, `/stock/SPX/greek-flow/${today}`);
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
    const rounded = roundTo5Min(new Date(tick.timestamp));
    sampled.set(rounded.toISOString(), tick);
  }

  const sql = getDb();
  let stored = 0;
  let skipped = 0;

  for (const [ts, tick] of sampled) {
    try {
      // Store delta flow in ncp/npp columns for compatibility with flow_data table.
      // ncp = total_delta_flow, npp = dir_delta_flow, net_volume = volume.
      // otm_ncp = otm_total_delta_flow, otm_npp = otm_dir_delta_flow
      // (wings-only variants that better represent directional conviction).
      const result = await sql`
        INSERT INTO flow_data (
          date, timestamp, source,
          ncp, npp, net_volume,
          otm_ncp, otm_npp
        )
        VALUES (
          ${today}, ${ts}, ${SOURCE},
          ${tick.total_delta_flow}, ${tick.dir_delta_flow}, ${tick.volume},
          ${tick.otm_total_delta_flow}, ${tick.otm_dir_delta_flow}
        )
        ON CONFLICT (date, timestamp, source) DO NOTHING
        RETURNING id
      `;
      if (result.length > 0) stored++;
      else skipped++;
    } catch (err) {
      logger.warn({ err, ts }, 'Greek flow insert failed');
      metrics.increment('fetch_greek_flow.store_error');
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
    const ticks = await withRetry(() => fetchGreekFlow(apiKey, today));
    const result = await withRetry(() => storeLatest(ticks, today));

    const latest = ticks.at(-1);
    logger.info(
      {
        totalTicks: ticks.length,
        ...result,
        latestDelta: latest?.total_delta_flow,
        latestDirDelta: latest?.dir_delta_flow,
        latestOtmDelta: latest?.otm_total_delta_flow,
        latestOtmDirDelta: latest?.otm_dir_delta_flow,
      },
      'fetch-greek-flow completed',
    );

    // Data quality check: alert if all values are zero/null
    if (result.stored > 10) {
      const rows = await getDb()`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE ncp::numeric != 0 OR npp::numeric != 0) AS nonzero
        FROM flow_data
        WHERE date = ${today} AND source = ${SOURCE}
      `;
      const { total, nonzero } = rows[0]!;
      await checkDataQuality({
        job: 'fetch-greek-flow',
        table: 'flow_data',
        date: today,
        sourceFilter: SOURCE,
        total: Number(total),
        nonzero: Number(nonzero),
      });
    }

    const durationMs = Date.now() - startTime;
    await reportCronRun('fetch-greek-flow', {
      status: 'ok',
      ticks: ticks.length,
      stored: result.stored,
      skipped: result.skipped,
      durationMs,
    });

    return res.status(200).json({
      job: 'fetch-greek-flow',
      ticks: ticks.length,
      ...result,
      durationMs,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-greek-flow');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-greek-flow error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
