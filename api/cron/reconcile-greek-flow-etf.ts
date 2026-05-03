/**
 * GET /api/cron/reconcile-greek-flow-etf
 *
 * Post-close reconciliation pass for the SPY/QQQ Greek Flow data
 * populated by fetch-greek-flow-etf.
 *
 * Why this exists:
 *   UW restates per-minute Greek-flow aggregates as late prints and
 *   cancellations settle. The live cron (fetch-greek-flow-etf) already
 *   UPSERTs every minute during market hours so it picks up *intraday*
 *   restatements. But UW's final post-close reconciliation can land
 *   AFTER the last 21:59 UTC live-cron tick. This cron re-fetches the
 *   just-closed session once, an hour after close, to overwrite any
 *   rows whose values were finalized after the live cron stopped.
 *
 * Schedule: vercel.json registers `0 22 * * 1-5` (22:00 UTC = 5:00 PM ET).
 *
 * Total API calls per invocation: 2 (SPY + QQQ in parallel).
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import { cronJitter, uwFetch, withRetry } from '../_lib/api-helpers.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import {
  upsertGreekFlowTicks,
  type GreekFlowTick,
} from '../_lib/greek-flow-etf-store.js';

export default withCronInstrumentation(
  'reconcile-greek-flow-etf',
  async (ctx): Promise<CronResult> => {
    const { apiKey, today } = ctx;
    await cronJitter();

    const [spyTicks, qqqTicks] = await Promise.all([
      withRetry(() =>
        uwFetch<GreekFlowTick>(apiKey, `/stock/SPY/greek-flow?date=${today}`),
      ),
      withRetry(() =>
        uwFetch<GreekFlowTick>(apiKey, `/stock/QQQ/greek-flow?date=${today}`),
      ),
    ]);

    const [spyResult, qqqResult] = await Promise.all([
      upsertGreekFlowTicks('SPY', spyTicks, today),
      upsertGreekFlowTicks('QQQ', qqqTicks, today),
    ]);

    ctx.logger.info(
      {
        date: today,
        spy: { ticks: spyTicks.length, ...spyResult },
        qqq: { ticks: qqqTicks.length, ...qqqResult },
      },
      'reconcile-greek-flow-etf completed',
    );

    return {
      status: 'success',
      metadata: {
        date: today,
        tickers: {
          SPY: { ticks: spyTicks.length, ...spyResult },
          QQQ: { ticks: qqqTicks.length, ...qqqResult },
        },
      },
    };
  },
  // Reconcile fires AFTER market hours close (22:00 UTC ≈ 5:00 PM ET) to
  // catch UW's post-close restatement, so the default market-hours gate
  // is disabled.
  { marketHours: false },
);
