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
  type UpsertResult,
} from '../_lib/greek-flow-etf-store.js';

/** Stored on every vega_flow_etf revision this run writes (spec P0.9). */
const WRITER = 'reconcile-greek-flow-etf';

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
        upsertGreekFlowTicks('SPY', spyAllTicks, today, null, WRITER),
        upsertGreekFlowTicks('QQQ', qqqAllTicks, today, null, WRITER),
        upsertGreekFlowTicks('SPY', spy0dteTicks, today, today, WRITER),
        upsertGreekFlowTicks('QQQ', qqq0dteTicks, today, today, WRITER),
      ]);

    // The store swallows its own write error and resolves with { failed: N }.
    // This run exists to land UW's final post-close values, so a scope that
    // failed to write is a failed run, not a success with a failed count in
    // the metadata (R4). Throwing sends the run to Sentry and Axiom as an
    // error and answers 500.
    const scopes: [string, UpsertResult][] = [
      ['SPY/all', spyAllResult],
      ['QQQ/all', qqqAllResult],
      ['SPY/0dte', spy0dteResult],
      ['QQQ/0dte', qqq0dteResult],
    ];
    const failedScopes = scopes.filter(([, result]) => result.failed > 0);
    if (failedScopes.length > 0) {
      const detail = failedScopes
        .map(([scope, result]) => `${scope}=${result.failed}`)
        .join(', ');
      throw new Error(
        `reconcile-greek-flow-etf: store write failed for ${today} (failed ticks: ${detail})`,
      );
    }

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
