/**
 * GET /api/cron/fetch-greek-flow-etf
 *
 * Fetches all-expiries directional vega and delta flow for SPY and QQQ
 * from the Unusual Whales Greek Flow endpoint. Both tickers are fetched
 * in parallel.
 *
 * Unlike the SPX cron (fetch-greek-flow), which uses the 0DTE-only
 * /{expiry} sub-route and downsamples to 5-min intervals, this cron:
 *   - Uses /stock/{ticker}/greek-flow?date={today} (all expiries variant)
 *   - Stores ticks at FULL 1-minute resolution intentionally, because
 *     ETF options flow signal concentrates in short bursts that would be
 *     smeared by 5-min sampling.
 *
 * Stored in vega_flow_etf table (migration #92).
 * Unique constraint: (ticker, timestamp) — ON CONFLICT DO NOTHING.
 *
 * Total API calls per invocation: 2 (SPY + QQQ in parallel)
 *
 * Schedule: vercel.json registers `* 13-21 * * 1-5` (every minute).
 * The original spec called for a 15-second stagger off the minute to
 * decouple from fetch-spx-candles-1m, but Vercel cron resolution is
 * minute-only — sub-minute offsets aren't expressible. The simultaneous
 * fire is fine: UW rate limits are well above the combined load of all
 * minute-cadence crons in this project.
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { cronGuard, uwFetch, withRetry } from '../_lib/api-helpers.js';
import { reportCronRun } from '../_lib/axiom.js';

// ── Types ───────────────────────────────────────────────────

interface GreekFlowTick {
  timestamp: string;
  ticker: string;
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

// ── Store at 1-min resolution ────────────────────────────────

async function storeTicks(
  ticker: string,
  ticks: GreekFlowTick[],
  today: string,
): Promise<{ stored: number; skipped: number }> {
  if (ticks.length === 0) return { stored: 0, skipped: 0 };

  const sql = getDb();
  let stored = 0;
  let skipped = 0;

  for (const tick of ticks) {
    try {
      const result = await sql`
        INSERT INTO vega_flow_etf (
          ticker, date, timestamp,
          dir_vega_flow, otm_dir_vega_flow, total_vega_flow, otm_total_vega_flow,
          dir_delta_flow, otm_dir_delta_flow, total_delta_flow, otm_total_delta_flow,
          transactions, volume
        )
        VALUES (
          ${ticker}, ${today}, ${tick.timestamp},
          ${tick.dir_vega_flow}, ${tick.otm_dir_vega_flow}, ${tick.total_vega_flow}, ${tick.otm_total_vega_flow},
          ${tick.dir_delta_flow}, ${tick.otm_dir_delta_flow}, ${tick.total_delta_flow}, ${tick.otm_total_delta_flow},
          ${tick.transactions}, ${tick.volume}
        )
        ON CONFLICT (ticker, timestamp) DO NOTHING
        RETURNING id
      `;
      if (result.length > 0) stored++;
      else skipped++;
    } catch (err) {
      logger.warn(
        { err, ticker, ts: tick.timestamp },
        'ETF greek flow insert failed',
      );
      metrics.increment('fetch_greek_flow_etf.store_error');
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
    const [spyTicks, qqqTicks] = await Promise.all([
      withRetry(() =>
        uwFetch<GreekFlowTick>(apiKey, `/stock/SPY/greek-flow?date=${today}`),
      ),
      withRetry(() =>
        uwFetch<GreekFlowTick>(apiKey, `/stock/QQQ/greek-flow?date=${today}`),
      ),
    ]);

    const [spyResult, qqqResult] = await Promise.all([
      storeTicks('SPY', spyTicks, today),
      storeTicks('QQQ', qqqTicks, today),
    ]);

    logger.info(
      {
        spy: { ticks: spyTicks.length, ...spyResult },
        qqq: { ticks: qqqTicks.length, ...qqqResult },
      },
      'fetch-greek-flow-etf completed',
    );

    const durationMs = Date.now() - startTime;
    await reportCronRun('fetch-greek-flow-etf', {
      status: 'ok',
      spy_ticks: spyTicks.length,
      spy_stored: spyResult.stored,
      spy_skipped: spyResult.skipped,
      qqq_ticks: qqqTicks.length,
      qqq_stored: qqqResult.stored,
      qqq_skipped: qqqResult.skipped,
      durationMs,
    });

    return res.status(200).json({
      job: 'fetch-greek-flow-etf',
      tickers: {
        SPY: { ticks: spyTicks.length, ...spyResult },
        QQQ: { ticks: qqqTicks.length, ...qqqResult },
      },
      durationMs,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-greek-flow-etf');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-greek-flow-etf error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
