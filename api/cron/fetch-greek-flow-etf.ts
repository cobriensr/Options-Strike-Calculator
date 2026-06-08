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
import { Sentry } from '../_lib/sentry.js';
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

    // Track per-leg failures across all three phases so the handler can
    // demote its status to 'partial' / 'error'. Previously a single
    // rejected leg in Phase A's mapWithConcurrency or Phase B/C's
    // Promise.all aborted every sibling and 500'd the whole run, dropping
    // healthy legs' data while the cron looked like a hard failure rather
    // than a partial one (BE-CRON-H4).
    let failureCount = 0;
    let legCount = 0;

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
    // Each worker catches its own rejection and returns a tagged result
    // so one ticker's 429 doesn't abort the batch via mapWithConcurrency's
    // internal Promise.all (which propagates the first rejection).
    //
    // Index order (SPY all-DTE, QQQ all-DTE, SPY expiry-breakdown,
    // QQQ expiry-breakdown) is load-bearing for tests that drive
    // mockUwFetch with mockResolvedValueOnce. Keep the order stable.
    type PhaseATask = { kind: 'all-dte' | 'expiry'; ticker: 'SPY' | 'QQQ' };
    type PhaseAOutcome =
      | { ok: true; data: unknown[] }
      | { ok: false; reason: unknown };
    const phaseATasks: PhaseATask[] = [
      { kind: 'all-dte', ticker: 'SPY' },
      { kind: 'all-dte', ticker: 'QQQ' },
      { kind: 'expiry', ticker: 'SPY' },
      { kind: 'expiry', ticker: 'QQQ' },
    ];
    const phaseAResults = await mapWithConcurrency<PhaseATask, PhaseAOutcome>(
      phaseATasks,
      3,
      async (task) => {
        try {
          if (task.kind === 'all-dte') {
            const data = await withRetry(() =>
              uwFetch<GreekFlowTick>(
                apiKey,
                `/stock/${task.ticker}/greek-flow?date=${today}`,
              ),
            );
            return { ok: true, data };
          }
          const data = await withRetry(() =>
            uwFetch<ExpiryBreakdownEntry>(
              apiKey,
              `/stock/${task.ticker}/expiry-breakdown?date=${today}`,
            ),
          );
          return { ok: true, data };
        } catch (err) {
          ctx.logger.warn(
            { err, ...task },
            'fetch-greek-flow-etf: Phase A leg failed',
          );
          Sentry.captureException(err);
          return { ok: false, reason: err };
        }
      },
    );

    const unwrapPhaseA = <T>(outcome: PhaseAOutcome): T[] => {
      legCount += 1;
      if (outcome.ok) return outcome.data as T[];
      failureCount += 1;
      return [];
    };

    const spyAllTicks = unwrapPhaseA<GreekFlowTick>(phaseAResults[0]!);
    const qqqAllTicks = unwrapPhaseA<GreekFlowTick>(phaseAResults[1]!);
    const spyExpiries = unwrapPhaseA<ExpiryBreakdownEntry>(phaseAResults[2]!);
    const qqqExpiries = unwrapPhaseA<ExpiryBreakdownEntry>(phaseAResults[3]!);

    // Phase B: only fetch per-expiry data if today is an expiry day for the
    // ticker. allSettled so a per-expiry 503 for SPY doesn't drop QQQ's.
    const spyIsExpiry = spyExpiries.some((e) => e.expires === today);
    const qqqIsExpiry = qqqExpiries.some((e) => e.expires === today);

    const [spy0dteSettled, qqq0dteSettled] = await Promise.allSettled([
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

    // Only count the per-expiry legs that were actually issued (expiry
    // days). A skipped (non-expiry) leg resolves to [] and is not a failure.
    if (spyIsExpiry) {
      legCount += 1;
      if (spy0dteSettled.status === 'rejected') {
        failureCount += 1;
        ctx.logger.warn(
          { err: spy0dteSettled.reason },
          'fetch-greek-flow-etf: SPY per-expiry fetch failed',
        );
        Sentry.captureException(spy0dteSettled.reason);
      }
    }
    if (qqqIsExpiry) {
      legCount += 1;
      if (qqq0dteSettled.status === 'rejected') {
        failureCount += 1;
        ctx.logger.warn(
          { err: qqq0dteSettled.reason },
          'fetch-greek-flow-etf: QQQ per-expiry fetch failed',
        );
        Sentry.captureException(qqq0dteSettled.reason);
      }
    }

    const spy0dteTicks =
      spy0dteSettled.status === 'fulfilled' ? spy0dteSettled.value : [];
    const qqq0dteTicks =
      qqq0dteSettled.status === 'fulfilled' ? qqq0dteSettled.value : [];

    // Phase C: upsert all four scopes independently. upsertGreekFlowTicks
    // catches its own DB errors and returns { failed } rather than throwing,
    // but allSettled guards against a connection-level rejection escaping
    // and aborting the other three scopes' writes.
    const [spyAllSettled, qqqAllSettled, spy0dteSettledC, qqq0dteSettledC] =
      await Promise.allSettled([
        upsertGreekFlowTicks('SPY', spyAllTicks, today, null),
        upsertGreekFlowTicks('QQQ', qqqAllTicks, today, null),
        upsertGreekFlowTicks('SPY', spy0dteTicks, today, today),
        upsertGreekFlowTicks('QQQ', qqq0dteTicks, today, today),
      ]);

    const ZERO_UPSERT = { inserted: 0, updated: 0, failed: 0 };
    const unwrapUpsert = (
      settled: PromiseSettledResult<{
        inserted: number;
        updated: number;
        failed: number;
      }>,
      inputTicks: number,
      scope: string,
    ): { inserted: number; updated: number; failed: number } => {
      // Only count scopes that actually had ticks to write as legs — an
      // empty-input upsert is a guaranteed no-op (upsertGreekFlowTicks
      // returns zeroes without touching the DB) and must not dilute the
      // all-failed ratio that drives the 'error' status.
      if (inputTicks > 0) legCount += 1;
      if (settled.status === 'fulfilled') return settled.value;
      if (inputTicks > 0) failureCount += 1;
      ctx.logger.warn(
        { err: settled.reason, scope },
        'fetch-greek-flow-etf: Phase C upsert rejected',
      );
      Sentry.captureException(settled.reason);
      return ZERO_UPSERT;
    };

    const spyAllResult = unwrapUpsert(
      spyAllSettled,
      spyAllTicks.length,
      'SPY/all',
    );
    const qqqAllResult = unwrapUpsert(
      qqqAllSettled,
      qqqAllTicks.length,
      'QQQ/all',
    );
    const spy0dteResult = unwrapUpsert(
      spy0dteSettledC,
      spy0dteTicks.length,
      'SPY/0dte',
    );
    const qqq0dteResult = unwrapUpsert(
      qqq0dteSettledC,
      qqq0dteTicks.length,
      'QQQ/0dte',
    );

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

    // Status demotion (matches fetch-gex-strike-expiry-etfs convention):
    //   every issued leg failed → 'error', some failed → 'partial', none →
    //   'success'. legCount counts only legs actually issued (skipped
    //   non-expiry per-expiry legs don't count), so a non-expiry day with
    //   all 6 issued legs healthy still reports 'success'.
    const allFailed = legCount > 0 && failureCount === legCount;
    const status = allFailed
      ? 'error'
      : failureCount > 0
        ? 'partial'
        : 'success';

    ctx.logger.info(
      { spy: spyMeta, qqq: qqqMeta, failureCount, legCount, status },
      'fetch-greek-flow-etf completed',
    );

    return {
      status,
      metadata: {
        failureCount,
        tickers: {
          SPY: spyMeta,
          QQQ: qqqMeta,
        },
      },
    };
  },
);
