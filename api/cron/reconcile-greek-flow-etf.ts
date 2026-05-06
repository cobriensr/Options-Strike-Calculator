/**
 * GET /api/cron/reconcile-greek-flow-etf
 *
 * Post-close reconciliation pass for the SPY/QQQ Greek Flow data
 * populated by fetch-greek-flow-etf. Reconciles BOTH scopes:
 *
 *   1. ALL-DTE — `/stock/{ticker}/greek-flow?date={today}` (existing)
 *   2. PER-EXPIRY (0DTE) — `/stock/{ticker}/greek-flow/{today}?date={today}`
 *      when today was a valid SPY/QQQ expiry. Determined via
 *      `/stock/{ticker}/expiry-breakdown?date={today}`.
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
 * Total API calls per invocation:
 *   - 4 on non-expiry days (2 all-DTE + 2 expiry-breakdown)
 *   - 6 on expiry days (above + 2 per-expiry)
 *
 * Environment: UW_API_KEY, CRON_SECRET
 *
 * See docs/superpowers/specs/greek-flow-0dte-toggle-2026-05-06.md.
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

interface ExpiryBreakdownEntry {
  // Live UW API uses `expires` (OpenAPI spec at /api/stock/{ticker}/
  // expiry-breakdown documents `expiry`, but the live response shape
  // uses `expires` — verified by curl 2026-05-06).
  expires: string;
  chains: number;
  open_interest: number;
  volume: number;
}

export default withCronInstrumentation(
  'reconcile-greek-flow-etf',
  async (ctx): Promise<CronResult> => {
    const { apiKey, today } = ctx;
    await cronJitter();

    const [spyAllTicks, qqqAllTicks, spyExpiries, qqqExpiries] =
      await Promise.all([
        withRetry(() =>
          uwFetch<GreekFlowTick>(apiKey, `/stock/SPY/greek-flow?date=${today}`),
        ),
        withRetry(() =>
          uwFetch<GreekFlowTick>(apiKey, `/stock/QQQ/greek-flow?date=${today}`),
        ),
        withRetry(() =>
          uwFetch<ExpiryBreakdownEntry>(
            apiKey,
            `/stock/SPY/expiry-breakdown?date=${today}`,
          ),
        ),
        withRetry(() =>
          uwFetch<ExpiryBreakdownEntry>(
            apiKey,
            `/stock/QQQ/expiry-breakdown?date=${today}`,
          ),
        ),
      ]);

    const spyIsExpiry = spyExpiries.some((e) => e.expires === today);
    const qqqIsExpiry = qqqExpiries.some((e) => e.expires === today);

    const [spy0dteTicks, qqq0dteTicks] = await Promise.all([
      spyIsExpiry
        ? withRetry(() =>
            uwFetch<GreekFlowTick>(
              apiKey,
              `/stock/SPY/greek-flow/${today}?date=${today}`,
            ),
          )
        : Promise.resolve<GreekFlowTick[]>([]),
      qqqIsExpiry
        ? withRetry(() =>
            uwFetch<GreekFlowTick>(
              apiKey,
              `/stock/QQQ/greek-flow/${today}?date=${today}`,
            ),
          )
        : Promise.resolve<GreekFlowTick[]>([]),
    ]);

    const [spyAllResult, qqqAllResult, spy0dteResult, qqq0dteResult] =
      await Promise.all([
        upsertGreekFlowTicks('SPY', spyAllTicks, today, null),
        upsertGreekFlowTicks('QQQ', qqqAllTicks, today, null),
        upsertGreekFlowTicks('SPY', spy0dteTicks, today, today),
        upsertGreekFlowTicks('QQQ', qqq0dteTicks, today, today),
      ]);

    const spyMeta = {
      all: { ticks: spyAllTicks.length, ...spyAllResult },
      expiry: spyIsExpiry
        ? { ticks: spy0dteTicks.length, ...spy0dteResult }
        : null,
    };
    const qqqMeta = {
      all: { ticks: qqqAllTicks.length, ...qqqAllResult },
      expiry: qqqIsExpiry
        ? { ticks: qqq0dteTicks.length, ...qqq0dteResult }
        : null,
    };

    ctx.logger.info(
      { date: today, spy: spyMeta, qqq: qqqMeta },
      'reconcile-greek-flow-etf completed',
    );

    return {
      status: 'success',
      metadata: {
        date: today,
        tickers: {
          SPY: spyMeta,
          QQQ: qqqMeta,
        },
      },
    };
  },
  // Reconcile fires AFTER market hours close (22:00 UTC ≈ 5:00 PM ET) to
  // catch UW's post-close restatement, so the default market-hours gate
  // is disabled.
  { marketHours: false },
);
