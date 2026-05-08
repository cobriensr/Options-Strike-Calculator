/**
 * GET /api/cron/fetch-greek-flow-etf
 *
 * Fetches directional vega and delta flow for SPY and QQQ from the
 * Unusual Whales Greek Flow endpoint, in two scopes:
 *
 *   1. ALL-DTE — `/stock/{ticker}/greek-flow?date={today}` (all expiries
 *      summed). Stored with `expiry = NULL`. Existing behavior.
 *   2. PER-EXPIRY (0DTE) — `/stock/{ticker}/greek-flow/{today}?date={today}`
 *      when today is a valid SPY/QQQ expiry. Stored with `expiry = today`.
 *      Powers the panel's 0DTE scope toggle.
 *
 * To know whether today is an SPY/QQQ expiry day (M/W/F weeklies + monthly
 * 3rd Friday + occasional special expiries), we hit `/stock/{ticker}/expiry-
 * breakdown?date={today}` which returns the canonical expiry list. If today
 * appears in that list for a given ticker, we fire the per-expiry call;
 * otherwise we skip it (no wasted call). This is the most-accurate route —
 * holiday-safe, calendar-drift-safe, future-proof against UW expiry-cadence
 * changes.
 *
 * Stored in vega_flow_etf table (migration #92, expiry column added in #129).
 * UPSERTs with `(ticker, timestamp, expiry)` unique key — UW restates per-
 * minute aggregates as late prints / cancellations resolve, so the live cron
 * is a continuous intraday reconciliation. A separate post-close
 * reconcile-greek-flow-etf cron handles end-of-day finalization for both
 * scopes.
 *
 * Total API calls per invocation:
 *   - 4 on non-expiry days (2 all-DTE + 2 expiry-breakdown)
 *   - 6 on expiry days (above + 2 per-expiry)
 *
 * Schedule: vercel.json registers `* 13-21 * * 1-5` (every minute).
 *
 * Environment: UW_API_KEY, CRON_SECRET
 *
 * See docs/superpowers/specs/greek-flow-0dte-toggle-2026-05-06.md.
 */

import {
  cronJitter,
  mapWithConcurrency,
  uwFetch,
  withRetry,
} from '../_lib/api-helpers.js';
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
  'fetch-greek-flow-etf',
  async (ctx): Promise<CronResult> => {
    const { apiKey, today } = ctx;
    await cronJitter();

    // Phase A: all-DTE flow + expiry breakdowns capped at the UW
    // 3-concurrent in-flight cap. A naked Promise.all over 4 calls
    // races against UW's per-account concurrency limit — the 4th
    // caller deterministically draws a "3 concurrent requests"
    // 429. Even though the global Redis semaphore in
    // `acquireConcurrencySlot()` will eventually serialize, paying
    // a Redis acquire+release for the 4th slot wastes a Redis
    // round-trip and tightens the timing race against UW's
    // server-side counter when other crons are simultaneously
    // contending for slots. `mapWithConcurrency` dispatches at most
    // 3 in flight upfront, eliminating both effects.
    //
    // Index order (SPY all-DTE, QQQ all-DTE, SPY expiry-breakdown,
    // QQQ expiry-breakdown) is load-bearing for tests that drive
    // mockUwFetch with mockResolvedValueOnce. Keep the order stable.
    type PhaseATask = { kind: 'all-dte' | 'expiry'; ticker: 'SPY' | 'QQQ' };
    const phaseATasks: PhaseATask[] = [
      { kind: 'all-dte', ticker: 'SPY' },
      { kind: 'all-dte', ticker: 'QQQ' },
      { kind: 'expiry', ticker: 'SPY' },
      { kind: 'expiry', ticker: 'QQQ' },
    ];
    const phaseAResults = await mapWithConcurrency(
      phaseATasks,
      3,
      async (task) => {
        if (task.kind === 'all-dte') {
          return withRetry(() =>
            uwFetch<GreekFlowTick>(
              apiKey,
              `/stock/${task.ticker}/greek-flow?date=${today}`,
            ),
          );
        }
        return withRetry(() =>
          uwFetch<ExpiryBreakdownEntry>(
            apiKey,
            `/stock/${task.ticker}/expiry-breakdown?date=${today}`,
          ),
        );
      },
    );
    const spyAllTicks = phaseAResults[0] as GreekFlowTick[];
    const qqqAllTicks = phaseAResults[1] as GreekFlowTick[];
    const spyExpiries = phaseAResults[2] as ExpiryBreakdownEntry[];
    const qqqExpiries = phaseAResults[3] as ExpiryBreakdownEntry[];

    // Phase B: only fetch per-expiry data if today is an expiry day for the ticker.
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

    // Phase C: upsert all four scopes in parallel.
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
      { spy: spyMeta, qqq: qqqMeta },
      'fetch-greek-flow-etf completed',
    );

    return {
      status: 'success',
      metadata: {
        tickers: {
          SPY: spyMeta,
          QQQ: qqqMeta,
        },
      },
    };
  },
);
