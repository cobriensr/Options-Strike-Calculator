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
 * Provenance: the write tags the row outcome_source = 'ws_cron',
 * outcome_version = 1. A ws_cron outcome is provisional. The websocket feed
 * drops prints it cannot replay, so the nightly Full Tape pass re-examines
 * every day and replaces it (owner, 2026-11-06: the tape has the final say).
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
 * Cadence: 21:45 and 23:45 UTC Mon-Fri, both after the 20:20/21:20 UTC
 * (EDT/EST) settle instant. The second slot retries what the first left
 * (a feed gap, a read that kept timing out), which matters most on Friday:
 * Monday's run no longer reaches Friday's alerts. About 250 alerts a day,
 * i.e. a few chunks.
 *
 * Flow repair: after the outcome pass, `repairNullFlow`
 * (api/_lib/fire-flow-repair.ts) fills `cum_ncp_at_fire` / `cum_npp_at_fire`
 * of the alerts of today and the four days before it that the live detector
 * wrote without flow (its series read ran past its deadline). A step of this
 * cron, not a cron: no schedule, monitor or env var of its own. It starts no
 * ticker-day in the last 60 s of the 300 s (pinned in vercel.json `functions`),
 * and its counts ride in `metadata.flowRepair`. A failed read or write makes
 * the run `partial`; the last slot of the day (23:45 UTC) raises one Sentry
 * error for alerts still without flow. The two steps are independent: if the
 * outcome pass throws (its candidate SELECT, an aggregate read, an UPDATE), the
 * repair still runs, and the pass's error is rethrown after it, so the run stays
 * an `error` with the real exception captured (the repair's counts are then
 * logged, not in the Axiom event). Spec: docs/superpowers/specs/
 * lottery-flow-repair-and-indexes-2026-11-15.md, Phase B.
 *
 * Environment: CRON_SECRET
 *
 * Spec: docs/superpowers/specs/lottery-enrichment-starvation-2026-10-02.md
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import { WS_OPTION_TRADES_RETENTION_DAYS } from '../_lib/constants.js';
import {
  withCronInstrumentation,
  type CronContext,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import { repairNullFlow, worseStatus } from '../_lib/fire-flow-repair.js';
import {
  enrichOutcomeWindows,
  outcomePassStatus,
  prepareWindows,
  type OutcomeCandidate,
} from '../_lib/option-outcome-aggregate.js';

type Sql = ReturnType<typeof getDb>;

/**
 * No chunk starts after this much of the run: the same 150 s as the
 * lottery tape pass (TAPE_PASS_BUDGET_MS), leaving ~150 s of the 300 s
 * maxDuration (the Fluid Compute default, pinned in vercel.json `functions`
 * since the flow repair step measures its own deadline from it) for an
 * in-flight chunk and its write, and then the flow repair step.
 */
const PASS_BUDGET_MS = 150_000;

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
 *
 * outcome_source / outcome_version are inline literals: bump the version when
 * the computation changes; migration #201's CHECKs pin the vocabulary.
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
             enriched_at = NOW(),
             outcome_source = 'ws_cron',
             outcome_version = 1
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

async function runOutcomePass(sql: Sql, ctx: CronContext) {
  const candidates = await selectCandidates(sql);
  const { windows, skipped, inFlight } = prepareWindows(candidates, Date.now());
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
  return { candidates: candidates.length, skipped, inFlight, pass };
}

export default withCronInstrumentation(
  'enrich-silent-boom-outcomes',
  async (ctx): Promise<CronResult> => {
    const sql = getDb();

    // The outcome pass and the flow repair are independent: a throw in the pass
    // (its candidate SELECT, an aggregate read, an UPDATE) must not cost the
    // repair its slot. The error is held and rethrown after the repair, so the
    // run is still an `error` and the wrapper still captures the exception.
    const passRun = await runOutcomePass(sql, ctx).then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    // The flow repair runs last and starts no ticker-day in the final 60 s of
    // the 300 s. Its failures are counted in `flow` and cannot fail the
    // outcomes above.
    const flow = await repairNullFlow(sql, {
      table: 'silentboom',
      job: 'enrich-silent-boom-outcomes',
      today: ctx.today,
      startTimeMs: ctx.startTimeMs,
    });

    if (!passRun.ok) {
      // The wrapper reports the throw without this run's metadata, so the
      // repair's counts are logged here.
      ctx.logger.info(
        { flowRepair: flow.counts },
        'enrich-silent-boom-outcomes: outcome pass failed; flow repair ran',
      );
      throw passRun.error;
    }
    const { candidates, skipped, inFlight, pass } = passRun.result;

    // `flowRepair` is one nested object, which reportCronRun folds into its
    // `meta` string: no new top-level Axiom column.
    const metadata = {
      candidates,
      updated: pass.locked,
      alreadyLocked: pass.alreadyLocked,
      skipped,
      inFlight,
      deferred: pass.deferred,
      tapeGap: pass.tapeGapIds.length,
      noPrints: pass.noPrintsIds.length,
      unreadable: pass.unreadableIds.length,
      readFailed: pass.readFailedIds.length,
      flowRepair: flow.counts,
    };
    ctx.logger.info(metadata, 'enrich-silent-boom-outcomes completed');

    const passStatus = outcomePassStatus(pass);
    if (passStatus === 'error') {
      return {
        status: 'error',
        rows: pass.locked,
        message:
          `${pass.tapeGapIds.length} alert(s) with a ws_option_trades ` +
          `gap and ${pass.readFailedIds.length} whose tape read kept ` +
          'timing out; left unenriched',
        metadata,
      };
    }
    return {
      status: worseStatus(passStatus, flow.status),
      rows: pass.locked,
      ...(flow.message != null ? { message: flow.message } : {}),
      metadata,
    };
  },
  // Runs after the close (cronGuard would reject it during its default
  // market-hours gate); DB-only, so no UW key.
  { marketHours: false, requireApiKey: false },
);
