/**
 * GET /api/cron/enrich-lottery-outcomes
 *
 * Enriches lottery_finder_fires with realized outcomes, newest first, in
 * two time-boxed passes per run:
 *
 * 1. TAPE pass: realized_trail30_10 / hard30m / tier50_holdeod / eod_pct,
 *    peak_ceiling_pct and minutes_to_peak, read from ws_option_trades, then
 *    enriched_at = NOW().
 *    - Candidates: enriched_at IS NULL and trigger_time_ct inside the
 *      WS_OPTION_TRADES_RETENTION_DAYS window, newest first.
 *      cleanup-ws-option-trades only deletes rows older than ET midnight
 *      N days back, which is at or before NOW() - N days, so a candidate's
 *      whole tape is still there. Older fires are NOT candidates: that
 *      cleanup deletes in physical order and leaves old days PARTIALLY
 *      pruned (rows from June still exist), so an old fire would read a
 *      fragment of its tape.
 *    - Tape window: [entry_time_ct, close + 15 min] of the fire's ET date
 *      (explicit upper bound: a 1-3 DTE contract keeps printing on later
 *      days). Settle gate: nothing is read until that window plus a 5-min
 *      ingest grace has passed, so a manual mid-session run never locks
 *      today's fires on a partial tape.
 *    - One statement per chain-grouped chunk computes every policy per fire
 *      in SQL (api/_lib/option-outcome-aggregate.ts); writes are batched.
 *    - A fire is left UNENRICHED (never stamped with empty outcomes):
 *        tapeGap    — its ticker has an empty 5-min bucket after the entry
 *                     or a quiet close tail: the feed (or its uw-stream
 *                     shard) was down, so the tape is truncated. Sentry
 *                     warning, status 'error'.
 *        noPrints   — the ticker was live but the contract has no print at
 *                     all, although the entry itself is a print. Sentry
 *                     warning, status 'partial'.
 *        unreadable — the aggregate row is missing or inconsistent (a bug).
 *                     Sentry warning, status 'partial'.
 *      It is retried while inside the retention window, then ages out.
 *      Recover it from the parquet tape with
 *      scripts/enrich_lottery_outcomes.py.
 *
 * 2. FLOW-INVERSION pass: realized_flow_inversion_pct from the UW per-minute
 *    intraday tape (cached in option_intraday_nbbo) and the matched-side
 *    net flow. It does not read ws_option_trades, so its candidates are
 *    every settled fire with a NULL inversion in the last
 *    INVERSION_LOOKBACK_DAYS. Work is grouped by (chain, date): one UW call
 *    per chain, at most UW's 3 in flight. Chains UW already answered with no
 *    data ('empty' in option_intraday_nbbo_fetches, one batched lookup) are
 *    skipped. A fire whose inversion is genuinely undefined (e.g. no flow
 *    peak) stays NULL and is retried from the cache, without a UW call, until
 *    it ages out. A UW or DB failure on a chain is counted, sent to Sentry
 *    and makes the run 'partial'. Results are written every WRITE_BATCH, so
 *    a timeout loses at most one batch.
 *
 * Budget: maxDuration is 300 s. The tape pass starts no chunk after
 * TAPE_PASS_BUDGET_MS and the inversion pass starts no chain after
 * RUN_BUDGET_MS; whatever is left is picked up by the next run. A
 * 4.4K-fire day measured 109 s of tape reads (worst chunk 11.7 s) on
 * 2026-10-01. UW intraday costs about 1.2 s per chain at ~750 chains/day, so
 * the schedule has three post-close slots: `40 21,22,23 * * 1-5`. All three
 * come after the 20:20/21:20 UTC (EDT/EST) settle instant. The ~100 s after
 * the last start covers a normal chunk or chain several times over. A
 * statement that hits withDbRetry's full 3 x 30 s can still overrun; the
 * writes are per chunk / per batch, so a kill loses only the in-flight one.
 * The writes are conditional (`AND enriched_at IS NULL`, `AND
 * realized_flow_inversion_pct IS NULL`), so overlapping runs are idempotent.
 *
 * Out of reach: fires older than the retention window that were never
 * enriched (06-25 onward, ~183K, starved by the old oldest-first drain) and
 * fires stamped with NULL outcomes by the old no-tick branch (06-17 to
 * 06-24). This cron deliberately never touches them; the parquet script is
 * the recovery path.
 *
 * Environment: CRON_SECRET, UW_API_KEY
 *
 * Spec: docs/superpowers/specs/lottery-enrichment-starvation-2026-10-02.md
 */

import { getDb, withDbRetry, safeDbVoid } from '../_lib/db.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import {
  KEPT_RETENTION_DAYS,
  WS_OPTION_TRADES_RETENTION_DAYS,
} from '../_lib/constants.js';
import {
  withCronInstrumentation,
  type CronContext,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import { fetchAndCacheOptionIntraday } from '../_lib/option-intraday.js';
import {
  simulateFlowInversion,
  type FlowMinute,
} from '../_lib/flow-inversion.js';
import {
  enrichOutcomeWindows,
  outcomePassStatus,
  prepareWindows,
  sessionTapeBounds,
  type OutcomeCandidate,
  type OutcomePassResult,
} from '../_lib/option-outcome-aggregate.js';
import { mapWithConcurrency } from '../_lib/uw-fetch.js';

type Sql = ReturnType<typeof getDb>;
type DbNumeric = string | number;
type DbTimestamp = string | Date;

/** The tape pass starts no new chunk after this much of the run. */
const TAPE_PASS_BUDGET_MS = 150_000;

/** The inversion pass starts no new chain after this much of the run. */
const RUN_BUDGET_MS = 200_000;

/** Covers a Friday fire on Monday's runs (Fri 20:00Z → Mon 23:40Z < 4 d). */
const INVERSION_LOOKBACK_DAYS = 4;

/** UW caps in-flight requests at 3 (see mapWithConcurrency). */
const INVERSION_CONCURRENCY = 3;

/** Rows per batched UPDATE (R5). */
const WRITE_BATCH = 500;

interface TapeUpdate {
  id: number;
  trail30_10: number;
  hard30m: number;
  tier50: number;
  eod: number;
  peak: number;
  minToPeak: number;
}

interface InversionCandidate {
  id: DbNumeric;
  optionChainId: string;
  underlyingSymbol: string;
  optionType: 'C' | 'P';
  date: string;
  triggerTimeCt: DbTimestamp;
  entryPrice: DbNumeric | null;
}

/** One UW intraday call's worth of work: every fire on a (chain, date). */
interface InversionGroup {
  chain: string;
  ticker: string;
  optionType: 'C' | 'P';
  date: string;
  fires: Array<{ id: number; entryPx: number; triggerTime: Date }>;
}

interface FlowRow {
  ts: Date;
  netCallPrem: DbNumeric | null;
  netPutPrem: DbNumeric | null;
}

const toNum = (v: DbNumeric | null): number =>
  v == null ? Number.NaN : Number(v);

const toDate = (v: DbTimestamp): Date => (v instanceof Date ? v : new Date(v));

const elapsedMs = (ctx: CronContext): number => Date.now() - ctx.startTimeMs;

/** Finite and > 0 (rejects NaN from an unparseable price). */
const isPositive = (n: number): boolean => Number.isFinite(n) && n > 0;

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
             enriched_at = NOW()
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

async function selectInversionCandidates(
  sql: Sql,
): Promise<InversionCandidate[]> {
  return (await withDbRetry(
    () => sql`
      SELECT id,
             option_chain_id AS "optionChainId",
             underlying_symbol AS "underlyingSymbol",
             option_type AS "optionType",
             date::text AS date,
             trigger_time_ct AS "triggerTimeCt",
             entry_price::float8 AS "entryPrice"
        FROM lottery_finder_fires
       WHERE realized_flow_inversion_pct IS NULL
         AND date >= ((NOW() - make_interval(days => ${INVERSION_LOOKBACK_DAYS}::int))
                      AT TIME ZONE 'America/New_York')::date
         AND trigger_time_ct >= NOW() - make_interval(days => ${INVERSION_LOOKBACK_DAYS}::int)
       ORDER BY trigger_time_ct DESC
       LIMIT 30000
    `,
    2,
    10_000,
  )) as InversionCandidate[];
}

/**
 * Per-minute matched-side flow for one (ticker, date, side). The cache holds
 * the in-flight promise so concurrent chains on the same ticker share one
 * SELECT; a rejected load is dropped so the next chain retries it.
 */
function loadMatchedFlow(
  cache: Map<string, Promise<FlowMinute[]>>,
  sql: Sql,
  ticker: string,
  date: string,
  optionType: 'C' | 'P',
): Promise<FlowMinute[]> {
  const key = `${ticker}|${date}|${optionType}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const load = (async () => {
    const rows = (await withDbRetry(
      () => sql`
        SELECT ts, net_call_prem AS "netCallPrem", net_put_prem AS "netPutPrem"
          FROM net_flow_per_ticker_history
         WHERE ticker = ${ticker}
           AND ts >= ${`${date}T00:00:00Z`}::timestamptz
           AND ts <  ${`${date}T00:00:00Z`}::timestamptz + INTERVAL '1 day'
         ORDER BY ts ASC
      `,
      2,
      10_000,
    )) as FlowRow[];
    const out: FlowMinute[] = [];
    for (const r of rows) {
      const value = toNum(optionType === 'C' ? r.netCallPrem : r.netPutPrem);
      if (Number.isFinite(value)) out.push({ ts: toDate(r.ts), value });
    }
    return out;
  })();
  cache.set(key, load);
  load.catch(() => cache.delete(key));
  return load;
}

/** One conditional write of up to WRITE_BATCH computed inversions. */
async function writeInversionBatch(
  sql: Sql,
  batch: ReadonlyArray<{ id: number; pct: number }>,
): Promise<number> {
  const rows = (await withDbRetry(
    () => sql`
      UPDATE lottery_finder_fires AS f
         SET realized_flow_inversion_pct = u.inv
        FROM unnest(
               ${batch.map((r) => r.id)}::bigint[],
               ${batch.map((r) => r.pct)}::float8[]
             ) AS u(id, inv)
       WHERE f.id = u.id
         AND f.realized_flow_inversion_pct IS NULL
      RETURNING f.id
    `,
    2,
    30_000,
  )) as Array<{ id: DbNumeric }>;
  return rows.length;
}

const groupKey = (chain: string, date: string): string => `${chain}|${date}`;

/**
 * (chain, date) pairs UW already answered with no intraday rows. ONE lookup
 * on the option_intraday_nbbo_fetches PK instead of a status SELECT per
 * chain on every slot; those chains can never yield an inversion (the fetch
 * ran after the settle instant), so they are skipped.
 */
async function readEmptyIntradayKeys(
  sql: Sql,
  groups: readonly InversionGroup[],
): Promise<Set<string>> {
  if (groups.length === 0) return new Set();
  const rows = (await withDbRetry(
    () => sql`
      SELECT f.option_chain AS chain, f.date::text AS date
        FROM option_intraday_nbbo_fetches f
        JOIN unnest(
               ${groups.map((g) => g.chain)}::text[],
               ${groups.map((g) => g.date)}::date[]
             ) AS u(chain, date)
          ON f.option_chain = u.chain AND f.date = u.date
       WHERE f.status = 'empty'
    `,
    2,
    10_000,
  )) as Array<{ chain: string; date: string }>;
  return new Set(rows.map((r) => groupKey(r.chain, r.date)));
}

interface InversionPassResult {
  candidates: number;
  chains: number;
  /** Chains skipped because UW already returned no intraday rows. */
  emptyChains: number;
  filled: number;
  undefinedExit: number;
  noIntradayMinutes: number;
  deferredChains: number;
  chainErrors: number;
}

async function runInversionPass(
  sql: Sql,
  ctx: CronContext,
): Promise<InversionPassResult> {
  const candidates = await selectInversionCandidates(sql);
  const nowMs = Date.now();
  const groups = new Map<string, InversionGroup>();
  for (const c of candidates) {
    const bounds = sessionTapeBounds(c.date);
    const entryPx = toNum(c.entryPrice);
    const triggerTime = toDate(c.triggerTimeCt);
    if (
      bounds === null ||
      bounds.settledAt.getTime() > nowMs ||
      !isPositive(entryPx) ||
      Number.isNaN(triggerTime.getTime())
    ) {
      continue;
    }
    const key = groupKey(c.optionChainId, c.date);
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        chain: c.optionChainId,
        ticker: c.underlyingSymbol,
        optionType: c.optionType,
        date: c.date,
        fires: [],
      };
      groups.set(key, group);
    }
    group.fires.push({ id: Number(c.id), entryPx, triggerTime });
  }

  const emptyKeys = await readEmptyIntradayKeys(sql, [...groups.values()]);
  // Groups keep first-seen order, so the newest chains go first.
  const work = [...groups.values()].filter(
    (g) => !emptyKeys.has(groupKey(g.chain, g.date)),
  );
  const result: InversionPassResult = {
    candidates: candidates.length,
    chains: groups.size,
    emptyChains: groups.size - work.length,
    filled: 0,
    undefinedExit: 0,
    noIntradayMinutes: 0,
    deferredChains: 0,
    chainErrors: 0,
  };
  const pending: Array<{ id: number; pct: number }> = [];
  const flowCache = new Map<string, Promise<FlowMinute[]>>();
  let firstError: unknown;

  /** Write full batches (or everything when `all`); a failure propagates. */
  const flush = async (all: boolean): Promise<void> => {
    while (pending.length >= WRITE_BATCH || (all && pending.length > 0)) {
      const batch = pending.splice(0, WRITE_BATCH);
      result.filled += await writeInversionBatch(sql, batch);
    }
  };

  await mapWithConcurrency(work, INVERSION_CONCURRENCY, async (group) => {
    if (elapsedMs(ctx) > RUN_BUDGET_MS) {
      result.deferredChains += 1;
      return;
    }
    try {
      const minutes = await fetchAndCacheOptionIntraday(
        ctx.apiKey,
        group.chain,
        group.date,
      );
      if (minutes.length === 0) {
        result.noIntradayMinutes += group.fires.length;
        return;
      }
      const flow = await loadMatchedFlow(
        flowCache,
        sql,
        group.ticker,
        group.date,
        group.optionType,
      );
      for (const f of group.fires) {
        const { exitPct } = simulateFlowInversion(
          minutes,
          flow,
          f.entryPx,
          f.triggerTime,
        );
        if (exitPct != null && Number.isFinite(exitPct)) {
          pending.push({ id: f.id, pct: exitPct });
        } else {
          result.undefinedExit += 1;
        }
      }
    } catch (err) {
      // One chain's UW/DB failure must not sink the others; it is counted,
      // logged, reported once below, and retried next run.
      result.chainErrors += 1;
      firstError ??= err;
      ctx.logger.warn(
        { err, chain: group.chain, date: group.date },
        'enrich-lottery-outcomes: flow-inversion failed for chain',
      );
    }
    // Outside the catch: a failed WRITE propagates (the run is not success).
    await flush(false);
  });

  if (firstError !== undefined) {
    Sentry.captureException(firstError, {
      fingerprint: ['enrich-lottery-outcomes', 'flow-inversion-chain'],
      extra: { chainErrors: result.chainErrors, chains: work.length },
    });
  }
  await flush(true);
  return result;
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
    const inversion = await runInversionPass(sql, ctx);

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
      inversion,
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
    return {
      status:
        tapeStatus === 'partial' || inversion.chainErrors > 0
          ? 'partial'
          : 'success',
      rows: tape.locked,
      metadata,
    };
  },
  // marketHours: false is REQUIRED — every slot runs after the close
  // (cronGuard defaults to marketHours: true and would reject the request).
  // UW_API_KEY stays required for the flow-inversion pass.
  { marketHours: false },
);
