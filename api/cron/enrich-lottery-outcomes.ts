/**
 * GET /api/cron/enrich-lottery-outcomes
 *
 * Enriches lottery_finder_fires with realized outcomes, newest first, in one
 * time-boxed tape pass per run: realized_trail30_10 / hard30m /
 * tier50_holdeod / eod_pct, peak_ceiling_pct and minutes_to_peak, read from
 * ws_option_trades, then enriched_at = NOW().
 *   - Candidates: enriched_at IS NULL and trigger_time_ct inside the
 *     WS_OPTION_TRADES_RETENTION_DAYS window, newest first.
 *     cleanup-ws-option-trades only deletes rows older than ET midnight
 *     N days back, which is at or before NOW() - N days, so a candidate's
 *     whole tape is still there. Older fires are NOT candidates: that
 *     cleanup deletes in physical order and leaves old days PARTIALLY
 *     pruned (rows from June still exist), so an old fire would read a
 *     fragment of its tape.
 *   - Tape window: [entry_time_ct, close + 15 min] of the fire's ET date
 *     (explicit upper bound: a 1-3 DTE contract keeps printing on later
 *     days). Settle gate: nothing is read until that window plus a 5-min
 *     ingest grace has passed, so a manual mid-session run never locks
 *     today's fires on a partial tape.
 *   - One statement per chain-grouped chunk computes every policy per fire
 *     in SQL (api/_lib/option-outcome-aggregate.ts); writes are batched.
 *   - A fire is left UNENRICHED (never stamped with empty outcomes):
 *       tapeGap    — its ticker has an empty 5-min bucket after the entry
 *                    or a quiet close tail: the feed (or its uw-stream
 *                    shard) was down, so the tape is truncated. Sentry
 *                    warning, status 'error'.
 *       noPrints   — the ticker was live but the contract has no print at
 *                    all, although the entry itself is a print. Sentry
 *                    warning, status 'partial'.
 *       unreadable — the aggregate row is missing or inconsistent (a bug).
 *                    Sentry warning, status 'partial'.
 *     It is retried while inside the retention window, then ages out.
 *     Recover it from the parquet tape with
 *     scripts/enrich_lottery_outcomes.py.
 *
 * Provenance: the write tags the row outcome_source = 'ws_cron',
 * outcome_version = 1. A ws_cron outcome is provisional. The websocket feed
 * drops prints it cannot replay, so the nightly Full Tape pass re-examines
 * every day and replaces it (owner, 2026-11-06: the tape has the final say).
 *
 * Flow inversion: this cron writes none (owner, 2026-11-06).
 * realized_flow_inversion_pct comes only from the nightly Full Tape pass
 * (tagged fulltape), a night after the session. The pass this cron used to
 * run read UW's per-minute intraday tape, and on a cache miss it fed those
 * minutes to simulateFlowInversion newest-first and unsorted, so its values
 * were wrong.
 *
 * Budget: maxDuration is 300 s. The pass starts no chunk after
 * TAPE_PASS_BUDGET_MS; whatever is left is picked up by the next run. A
 * 4.4K-fire day measured 109 s of tape reads (worst chunk 11.7 s) on
 * 2026-10-01. The schedule keeps three post-close slots, `40 21,22,23 * *
 * 1-5`, so a later slot retries the tape gaps an earlier one left. All three
 * come after the 20:20/21:20 UTC (EDT/EST) settle instant. The ~150 s after
 * the last start covers a normal chunk several times over. A statement that
 * hits withDbRetry's full 3 x 30 s can still overrun; the writes are per
 * chunk, so a kill loses only the in-flight one. The write is conditional
 * (`AND enriched_at IS NULL`), so overlapping runs are idempotent.
 *
 * Out of reach: fires older than the retention window that were never
 * enriched (06-25 onward, ~183K, starved by the old oldest-first drain) and
 * fires stamped with NULL outcomes by the old no-tick branch (06-17 to
 * 06-24). This cron deliberately never touches them; the parquet script is
 * the recovery path.
 *
 * Environment: CRON_SECRET. DB only, so no UW key.
 *
 * Spec: docs/superpowers/specs/lottery-enrichment-starvation-2026-10-02.md
 */

import { getDb, withDbRetry, safeDbVoid } from '../_lib/db.js';
import { metrics } from '../_lib/sentry.js';
import {
  KEPT_RETENTION_DAYS,
  WS_OPTION_TRADES_RETENTION_DAYS,
} from '../_lib/constants.js';
import {
  withCronInstrumentation,
  type CronContext,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import {
  enrichOutcomeWindows,
  outcomePassStatus,
  prepareWindows,
  type OutcomeCandidate,
  type OutcomePassResult,
} from '../_lib/option-outcome-aggregate.js';

type Sql = ReturnType<typeof getDb>;
type DbNumeric = string | number;

/** The tape pass starts no new chunk after this much of the run. */
const TAPE_PASS_BUDGET_MS = 150_000;

interface TapeUpdate {
  id: number;
  trail30_10: number;
  hard30m: number;
  tier50: number;
  eod: number;
  peak: number;
  minToPeak: number;
}

/**
 * In-window unenriched fires, newest first. The ET-date lower bound lets
 * lottery_finder_fires_date_ts_idx seek (measured 4.6 s → 13 ms).
 */
async function selectTapeCandidates(sql: Sql): Promise<OutcomeCandidate[]> {
  return (await withDbRetry(
    () => sql`
      SELECT id,
             option_chain_id AS chain,
             underlying_symbol AS ticker,
             date::text AS date,
             entry_time_ct AS entry,
             entry_price::float8 AS "entryPx"
        FROM lottery_finder_fires
       WHERE enriched_at IS NULL
         AND date >= ((NOW() - make_interval(days => ${WS_OPTION_TRADES_RETENTION_DAYS}::int))
                      AT TIME ZONE 'America/New_York')::date
         AND trigger_time_ct >= NOW() - make_interval(days => ${WS_OPTION_TRADES_RETENTION_DAYS}::int)
       ORDER BY trigger_time_ct DESC
       LIMIT 20000
    `,
    2,
    10_000,
  )) as OutcomeCandidate[];
}

/**
 * ONE batched UPDATE per chunk. Conditional on enriched_at IS NULL so an
 * overlapping run never rewrites a locked fire; RETURNING counts the rows
 * this run actually locked.
 *
 * outcome_source / outcome_version are inline literals: bump the version when
 * the computation changes; migration #201's CHECKs pin the vocabulary.
 */
async function lockTapeOutcomes(
  sql: Sql,
  updates: readonly TapeUpdate[],
): Promise<number> {
  const rows = (await withDbRetry(
    () => sql`
      UPDATE lottery_finder_fires AS f
         SET realized_trail30_10_pct = u.trail,
             realized_hard30m_pct = u.hard,
             realized_tier50_holdeod_pct = u.tier,
             realized_eod_pct = u.eod,
             peak_ceiling_pct = u.peak,
             minutes_to_peak = u.mtp,
             enriched_at = NOW(),
             outcome_source = 'ws_cron',
             outcome_version = 1
        FROM unnest(
               ${updates.map((u) => u.id)}::bigint[],
               ${updates.map((u) => u.trail30_10)}::float8[],
               ${updates.map((u) => u.hard30m)}::float8[],
               ${updates.map((u) => u.tier50)}::float8[],
               ${updates.map((u) => u.eod)}::float8[],
               ${updates.map((u) => u.peak)}::float8[],
               ${updates.map((u) => u.minToPeak)}::float8[]
             ) AS u(id, trail, hard, tier, eod, peak, mtp)
       WHERE f.id = u.id
         AND f.enriched_at IS NULL
      RETURNING f.id
    `,
    2,
    30_000,
  )) as Array<{ id: DbNumeric }>;
  return rows.length;
}

interface TapePassResult extends OutcomePassResult {
  candidates: number;
  skipped: number;
  inFlight: number;
}

async function runTapePass(
  sql: Sql,
  ctx: CronContext,
): Promise<TapePassResult> {
  const candidates = await selectTapeCandidates(sql);
  const { windows, skipped, inFlight } = prepareWindows(candidates, Date.now());
  const pass = await enrichOutcomeWindows(sql, windows, {
    job: 'enrich-lottery-outcomes',
    recovery: 'scripts/enrich_lottery_outcomes.py',
    logger: ctx.logger,
    deadlineMs: ctx.startTimeMs + TAPE_PASS_BUDGET_MS,
    toUpdate: (w, r): TapeUpdate => ({
      id: w.id,
      trail30_10: r.trail30_10Pct,
      hard30m: r.hard30mPct,
      tier50: r.tier50Pct,
      eod: r.eodPct,
      peak: r.peakPct,
      minToPeak: r.minutesToPeak,
    }),
    lock: (updates) => lockTapeOutcomes(sql, updates),
  });
  return { candidates: candidates.length, skipped, inFlight, ...pass };
}

/**
 * Best-effort retention prune for `lottery_kept_tickers` (the DB-backed
 * never-vanish kept-set). The table grows one row per (trade_date,
 * underlying_symbol) with no other cleanup, so without this it accumulates
 * forever. Keep `KEPT_RETENTION_DAYS` of history and drop anything older.
 *
 * Wrapped in `safeDbVoid` so a prune failure is swallowed (increments the
 * `db.error` metric) and NEVER fails this cron's primary enrichment job —
 * retention is strictly secondary to outcome enrichment.
 *
 * Retention window: today's rows (and any from the last KEPT_RETENTION_DAYS
 * days) are never touched. The strict `<` cutoff is LOAD-BEARING — it
 * preserves the Phase 1 write-amplification invariant in
 * `lottery-finder.ts`, whose set-difference diff-skip on `addKeptTickers`
 * depends on today's rows always being present in the table.
 *
 * SQL form: `(now() AT TIME ZONE 'America/New_York')::date
 * - ${KEPT_RETENTION_DAYS}::int` stays a `date` (date − integer = date), no
 * double-cast. The `::int` cast on the bound param resolves the otherwise-
 * ambiguous `date - $param` operator (Postgres can't infer the param type
 * for bare `-`), matching the codebase's existing numeric-param-vs-temporal
 * pattern (e.g. gexbot-queries.ts `${windowMinutes}::int * INTERVAL ...`).
 * KEPT_RETENTION_DAYS is a trusted compile-time constant, so binding it as
 * a param is safe (and keeps it observable in the cron test's mock harness).
 *
 * Emits the `lottery.kept_prune` heartbeat counter on each successful prune
 * so a silently-disabled/renamed cron shows up as a flatlined metric.
 */
async function pruneKeptTickers(sql: Sql): Promise<void> {
  await safeDbVoid(async () => {
    await sql`
      DELETE FROM lottery_kept_tickers
      WHERE trade_date
            < (now() AT TIME ZONE 'America/New_York')::date - ${KEPT_RETENTION_DAYS}::int
    `;
    metrics.increment('lottery.kept_prune');
  });
}

export default withCronInstrumentation(
  'enrich-lottery-outcomes',
  async (ctx): Promise<CronResult> => {
    const sql = getDb();

    const tape = await runTapePass(sql, ctx);

    // Best-effort, AFTER the enrichment writes have landed, so a prune
    // failure can never roll back or fail the primary job.
    await pruneKeptTickers(sql);

    const metadata = {
      candidates: tape.candidates,
      updated: tape.locked,
      alreadyLocked: tape.alreadyLocked,
      skipped: tape.skipped,
      inFlight: tape.inFlight,
      deferred: tape.deferred,
      tapeGap: tape.tapeGapIds.length,
      noPrints: tape.noPrintsIds.length,
      unreadable: tape.unreadableIds.length,
      readFailed: tape.readFailedIds.length,
    };

    ctx.logger.info(metadata, 'enrich-lottery-outcomes completed');

    const tapeStatus = outcomePassStatus(tape);
    if (tapeStatus === 'error') {
      return {
        status: 'error',
        rows: tape.locked,
        message:
          `${tape.tapeGapIds.length} fire(s) with a ws_option_trades gap and ` +
          `${tape.readFailedIds.length} whose tape read kept timing out; ` +
          'left unenriched',
        metadata,
      };
    }
    return { status: tapeStatus, rows: tape.locked, metadata };
  },
  // marketHours: false is REQUIRED — every slot runs after the close
  // (cronGuard defaults to marketHours: true and would reject the request).
  // DB-only since the flow-inversion pass was removed, so no UW key.
  { marketHours: false, requireApiKey: false },
);
