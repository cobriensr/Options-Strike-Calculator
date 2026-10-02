/**
 * GET /api/cron/enrich-silent-boom-outcomes
 *
 * Enriches silent_boom_alerts with realized outcomes read from
 * ws_option_trades, then sets enriched_at = NOW(). The outcomes are
 * peak_ceiling_pct, minutes_to_peak, realized_30m/60m/120m_pct (the last
 * print at or before entry + N min; NULL when none landed, never a fake
 * 0%), realized_eod_pct and realized_trail30_10_pct. Entry is `bucket_ct`,
 * the 5-min spike bucket start; the outcome window is [bucket_ct, close +
 * 15 min] on the alert's ET date.
 *
 * Shares the enrichment pass with enrich-lottery-outcomes
 * (api/_lib/option-outcome-aggregate.ts):
 *   - Candidates: enriched_at IS NULL and bucket_ct inside the
 *     WS_OPTION_TRADES_RETENTION_DAYS window, newest first. Older alerts
 *     are NOT candidates: cleanup-ws-option-trades leaves old days
 *     partially pruned, so their tape is fragmentary.
 *   - Settle gate: nothing is read until close + 15 min + 5 min grace.
 *   - One statement per chain-grouped chunk computes every outcome in SQL.
 *   - An alert is never stamped with empty outcomes. tapeGap (its ticker
 *     has an empty 5-min bucket after the spike or a quiet close tail: the
 *     feed or its uw-stream shard was down) raises a Sentry warning and
 *     returns status 'error'. noPrints and unreadable rows raise a Sentry
 *     warning and return 'partial'. All three stay candidates and are
 *     retried while inside the window.
 *
 * History: from 2026-06-12 (dd2b68ff) until this fix, every alert was
 * stamped enriched_at with NULL outcomes on its own evening even though its
 * tape existed. The batched read keyed ticks by an int4 id while the
 * candidate's int8 id arrived as a string, so no alert ever found its
 * ticks. The read also had no upper bound and drained oldest-first. Those
 * stamped rows are out of reach of this cron;
 * scripts/enrich_silent_boom_outcomes.py (parquet) is the recovery path.
 *
 * Cadence: 21:45 UTC Mon-Fri, after the 20:20/21:20 UTC (EDT/EST) settle
 * instant. About 250 alerts a day, i.e. a few chunks.
 *
 * Environment: CRON_SECRET
 *
 * Spec: docs/superpowers/specs/lottery-enrichment-starvation-2026-10-02.md
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import { WS_OPTION_TRADES_RETENTION_DAYS } from '../_lib/constants.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import {
  enrichOutcomeWindows,
  outcomePassStatus,
  prepareWindows,
  type OutcomeCandidate,
} from '../_lib/option-outcome-aggregate.js';

type Sql = ReturnType<typeof getDb>;

/**
 * No chunk starts after this much of the run: the same budget as the
 * lottery tape pass, well inside the Fluid Compute default maxDuration.
 */
const PASS_BUDGET_MS = 180_000;

interface AlertUpdate {
  id: number;
  peak: number;
  minToPeak: number;
  r30: number | null;
  r60: number | null;
  r120: number | null;
  eod: number;
  trail30: number;
}

/** In-window unenriched alerts, newest first (silent_boom_alerts_unenriched_idx). */
async function selectCandidates(sql: Sql): Promise<OutcomeCandidate[]> {
  return (await withDbRetry(
    () => sql`
      SELECT id,
             option_chain_id AS chain,
             underlying_symbol AS ticker,
             date::text AS date,
             bucket_ct AS entry,
             entry_price::float8 AS "entryPx"
        FROM silent_boom_alerts
       WHERE enriched_at IS NULL
         AND date >= ((NOW() - make_interval(days => ${WS_OPTION_TRADES_RETENTION_DAYS}::int))
                      AT TIME ZONE 'America/New_York')::date
         AND bucket_ct >= NOW() - make_interval(days => ${WS_OPTION_TRADES_RETENTION_DAYS}::int)
       ORDER BY bucket_ct DESC
       LIMIT 5000
    `,
    2,
    10_000,
  )) as OutcomeCandidate[];
}

/**
 * ONE batched UPDATE per chunk; the r30/r60/r120 arrays keep their NULLs.
 * Conditional on enriched_at IS NULL (idempotent under overlap); RETURNING
 * counts the rows this run actually locked.
 */
async function lockOutcomes(
  sql: Sql,
  updates: readonly AlertUpdate[],
): Promise<number> {
  const rows = (await withDbRetry(
    () => sql`
      UPDATE silent_boom_alerts AS s
         SET peak_ceiling_pct = u.peak,
             minutes_to_peak = u.mtp,
             realized_30m_pct = u.r30,
             realized_60m_pct = u.r60,
             realized_120m_pct = u.r120,
             realized_eod_pct = u.eod,
             realized_trail30_10_pct = u.trail30,
             enriched_at = NOW()
        FROM unnest(
               ${updates.map((u) => u.id)}::bigint[],
               ${updates.map((u) => u.peak)}::float8[],
               ${updates.map((u) => u.minToPeak)}::float8[],
               ${updates.map((u) => u.r30)}::float8[],
               ${updates.map((u) => u.r60)}::float8[],
               ${updates.map((u) => u.r120)}::float8[],
               ${updates.map((u) => u.eod)}::float8[],
               ${updates.map((u) => u.trail30)}::float8[]
             ) AS u(id, peak, mtp, r30, r60, r120, eod, trail30)
       WHERE s.id = u.id
         AND s.enriched_at IS NULL
      RETURNING s.id
    `,
    2,
    30_000,
  )) as Array<{ id: string | number }>;
  return rows.length;
}

export default withCronInstrumentation(
  'enrich-silent-boom-outcomes',
  async (ctx): Promise<CronResult> => {
    const sql = getDb();
    const candidates = await selectCandidates(sql);
    const { windows, skipped, inFlight } = prepareWindows(
      candidates,
      Date.now(),
    );
    const pass = await enrichOutcomeWindows(sql, windows, {
      job: 'enrich-silent-boom-outcomes',
      recovery: 'scripts/enrich_silent_boom_outcomes.py',
      logger: ctx.logger,
      deadlineMs: ctx.startTimeMs + PASS_BUDGET_MS,
      toUpdate: (w, r): AlertUpdate => ({
        id: w.id,
        peak: r.peakPct,
        minToPeak: r.minutesToPeak,
        r30: r.r30Pct,
        r60: r.r60Pct,
        r120: r.r120Pct,
        eod: r.eodPct,
        trail30: r.trail30_10Pct,
      }),
      lock: (updates) => lockOutcomes(sql, updates),
    });

    const metadata = {
      candidates: candidates.length,
      updated: pass.locked,
      alreadyLocked: pass.alreadyLocked,
      skipped,
      inFlight,
      deferred: pass.deferred,
      tapeGap: pass.tapeGapIds.length,
      noPrints: pass.noPrintsIds.length,
      unreadable: pass.unreadableIds.length,
    };
    ctx.logger.info(metadata, 'enrich-silent-boom-outcomes completed');

    const status = outcomePassStatus(pass);
    return {
      status,
      rows: pass.locked,
      ...(status === 'error'
        ? {
            message:
              `${pass.tapeGapIds.length} alert(s) left unenriched: ` +
              'ws_option_trades gap at the close',
          }
        : {}),
      metadata,
    };
  },
  // Runs after the close (cronGuard would reject it during its default
  // market-hours gate); DB-only, so no UW key.
  { marketHours: false, requireApiKey: false },
);
