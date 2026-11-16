/**
 * Automatic post-close repair of fires whose live flow read failed.
 *
 * Why it exists. `detect-lottery-fires` and `detect-silent-boom` read one
 * ticker-day's cumulative net-flow series (`fetchTickerFlowSeries`) before they
 * write a fire. When that read runs past its deadline (a slow read at the open:
 * 5.7 to 7.6 s cold, 2026-11-14) the fire is still written, with
 * `cum_ncp_at_fire` / `cum_npp_at_fire` NULL, and a lottery fire with no flow is
 * not aligned, so its V2 score is NULL too. Until now a human ran the backfill
 * and the re-score by hand. This module is the same repair, run automatically
 * as an extra step of the two post-close enrich crons (lottery 21:40, 22:40 and
 * 23:40 UTC; silent boom 21:45 and 23:45 UTC), 40 to 100 minutes after the
 * close, DB only. Spec: docs/superpowers/specs/
 * lottery-flow-repair-and-indexes-2026-11-15.md, section 3, Phase B.
 *
 * What it does, per run, for ONE table:
 *   1. `selectNullFlowGroups`: the ticker-days of the current ET date and the
 *      FLOW_REPAIR_LOOKBACK_DAYS days before it that hold a NULL-flow fire at or
 *      after that day's 08:30 CT open (a pre-open fire has no series to read and
 *      would be selected forever). The date range is the leading column of
 *      `lottery_finder_fires_date_ts_idx (date DESC, trigger_time_ct DESC)` and
 *      `silent_boom_alerts_date_bucket_idx (date DESC, bucket_ct DESC)`, so
 *      the read touches only those days (the NULL test is a filter on them).
 *   2. For each group, FLOW_REPAIR_CONCURRENCY at a time: the group's NULL rows,
 *      one `fetchTickerFlowSeries` (the Phase A rule: the WS rows of the day, or
 *      the history minutes only when it has no WS row), and `flowAtFireTime` per
 *      fire. A fire the series has no value for (before the ticker's first WS
 *      tick, or a ticker with no flow rows) has nothing to write: it stays NULL,
 *      as a healthy live run stores it, and it is not a failure.
 *   3. One conditional batched write per 500 rows: `UPDATE ... FROM unnest(...)
 *      WHERE cum_ncp_at_fire IS NULL ... RETURNING`, so a value another writer
 *      stored is never overwritten and a rerun finds nothing left. Counts come
 *      from RETURNING.
 *   4. Lottery fires, in the SAME statement as their flow: the V2 score under
 *      the `active` weights (`rescoreRow`, the live detector's computation), NULL
 *      when the fire is not aligned, tagged `score_version = active.version`,
 *      exactly as the detector stores it. The score part is guarded: the row
 *      must still have score NULL and the tag it was read with, and the `active`
 *      pointer must still name the version being written; a row that fails the
 *      guard is not written at all, so a later slot repairs it whole with the
 *      new version, and no row ends with flow but a stale score. Not re-scored:
 *      a fire from before SEED_WEIGHTS_LIVE_FROM (scored with older weights), a
 *      fire that already has a score, and a `tod` the weights do not know. If
 *      the weights store cannot be read (the loader's seed fallback) the flow is
 *      still written, the score is left NULL, and the run says so (`partial`):
 *      `scripts/rescore-lottery-v2-after-flow-backfill.ts` gives those fires
 *      their score.
 *
 * Time budget. The step starts no new group once FLOW_REPAIR_MARGIN_MS before
 * the cron's maxDuration, measured from the handler start (the lottery tape pass
 * runs first and can take about 110 s). A group in flight when the deadline
 * passes finishes; one not started is deferred, and the next slot picks it up.
 *
 * Honest status (R4). A failed selection, series read or write makes the run
 * `partial` and is captured: a genuine error with `captureException`, a
 * transient one (a Neon blip, a read past its deadline) with a warning message,
 * the first of each kind per run. The run never reports `success` over a failed
 * write. The residual alarm fires only in the day's last slot: one error-level
 * Sentry message per table with a fixed fingerprint, when a fire of that ET date
 * is left whose series HAS a value at the fire but stayed NULL, or whose
 * ticker-day series could not be read (error, deadline, or not started). Fires
 * before the ticker's first WS tick and pre-open fires are NOT residual. Only
 * the current date counts: an older date was alarmed at its own last slot.
 *
 * Axiom: the crons put this step's counts in `metadata.flowRepair`, one nested
 * object, which `reportCronRun` JSON-stringifies into `meta`. No new top-level
 * Axiom column.
 */

import { ctSessionBounds } from '../../src/components/LotteryFinder/ct-window.js';
import type { CronStatus } from './cron-instrumentation.js';
import { isRetryableDbError, withDbRetry, type getDb } from './db.js';
import { DeadlineError, withDeadline } from './deadline.js';
import logger from './logger.js';
import {
  SEED_WEIGHTS_LIVE_FROM,
  loadActive,
  rescoreRow,
} from './lottery-flow-rescore.js';
import type { VersionedWeights } from './lottery-weights-loader.js';
import { Sentry } from './sentry.js';
import {
  FLOW_SERIES_DEADLINE_MS,
  fetchTickerFlowSeries,
  flowAtFireTime,
} from './ticker-flow-snapshot.js';
import { mapWithConcurrency } from './uw-fetch.js';

type Sql = ReturnType<typeof getDb>;

export type FlowRepairTable = 'lottery' | 'silentboom';

/**
 * The current ET date and this many calendar days before it: a weekend plus one
 * missed weekday (on a Monday: Sunday, Saturday, Friday, Thursday).
 */
export const FLOW_REPAIR_LOOKBACK_DAYS = 4;

/** Ticker-day groups worked at once, as many series reads as the detectors run. */
export const FLOW_REPAIR_CONCURRENCY = 3;

/** The step starts no new group in the last 60 s before the cron's maxDuration. */
export const FLOW_REPAIR_MARGIN_MS = 60_000;

/**
 * `maxDuration` of both enrich crons in vercel.json `functions`
 * (`enrich-lottery-outcomes.ts` and `enrich-silent-boom-outcomes.ts`); a test
 * reads vercel.json and fails when either differs.
 */
export const FLOW_REPAIR_CRON_MAX_DURATION_MS = 300_000;

/**
 * The UTC hour of the last post-close slot of the day for both crons (23:40 and
 * 23:45 UTC). A run that starts in this hour may raise the residual alarm; a
 * test reads vercel.json and fails when a schedule has a later slot.
 */
export const FLOW_REPAIR_LAST_SLOT_UTC_HOUR = 23;

/** Rows per UPDATE, as everywhere in this repo's batch writes (R5). */
const WRITE_CHUNK = 500;

/** Ticker-days listed in the residual alarm's `extra`, so the message stays small. */
const RESIDUAL_SAMPLE = 10;

interface Group {
  ticker: string;
  /** `YYYY-MM-DD` */
  date: string;
  /** NULL-flow fires selected for this ticker-day. */
  nRows: number;
}

/**
 * A NULL-flow fire of one group: what the flow lookup (`at`) and, for lottery,
 * the re-score read (the columns the scorer takes, and the score state now).
 */
interface NullFire {
  id: string;
  at: Date | string;
  tod?: string | null;
  dte?: number | null;
  option_type?: 'C' | 'P' | null;
  trigger_vol_to_oi_window?: number | null;
  gamma_at_trigger?: number | null;
  trigger_ask_pct?: number | null;
  score?: number | null;
  score_version?: string | null;
}

/** One planned write: the flow, and for lottery the score and the tag. */
interface Planned {
  id: string;
  ncp: number;
  npp: number;
  /** The tag the row held when read, which the write guards on. */
  fromVersion: string | null;
  /** NULL `toVersion`: flow only, the score and the tag stay as they are. */
  toVersion: string | null;
  /** Meaningful only with a `toVersion`; NULL is a fire against the flow. */
  toScore: number | null;
}

/** What one ticker-day group came to. */
interface GroupOutcome {
  state: 'done' | 'deferred' | 'read-failed' | 'write-failed';
  error: unknown;
  fires: number;
  written: number;
  noValue: number;
  alreadyFilled: number;
  notWritten: number;
  scored: number;
  scoredNull: number;
  scoreLeft: number;
  rescoreSkipped: number;
}

function emptyOutcome(state: GroupOutcome['state']): GroupOutcome {
  return {
    state,
    error: null,
    fires: 0,
    written: 0,
    noValue: 0,
    alreadyFilled: 0,
    notWritten: 0,
    scored: 0,
    scoredNull: 0,
    scoreLeft: 0,
    rescoreSkipped: 0,
  };
}

/** The counts of one run of one table, as `metadata.flowRepair`. */
export interface FlowRepairCounts {
  /** Ticker-days with a NULL-flow fire at or after the open, newest first. */
  groups: number;
  groupsDone: number;
  /** Not started because the deadline passed: the next slot picks them up. */
  groupsDeferred: number;
  groupsReadFailed: number;
  groupsWriteFailed: number;
  /** NULL-flow fires in the groups that were read. */
  fires: number;
  /** Rows the write landed (RETURNING). */
  written: number;
  /** Fires the series has no value for: nothing to write, not a failure. */
  noValue: number;
  /** Planned rows another writer filled between the read and the write. */
  alreadyFilled: number;
  /** Planned rows still NULL after the write (a guard held them back). */
  notWritten: number;
  /** Lottery rows given a score and the active tag. */
  scored: number;
  /** Lottery rows given score NULL (not aligned) and the active tag. */
  scoredNull: number;
  /** Lottery rows written with their score left: pre-seed, already scored, unknown tod. */
  scoreLeft: number;
  /** Lottery rows written without a score because the weights store was unreadable. */
  rescoreSkipped: number;
  /** Fires of today's date still without flow that a later slot could repair. */
  residualFires: number;
  residualGroups: number;
  /** The selection query failed: nothing was repaired. */
  selectFailed: boolean;
  /** This run is the day's last slot, so the residual alarm was evaluated. */
  lastSlot: boolean;
}

export interface FlowRepairOutcome {
  /** `partial` when anything failed or was left that this run could not repair. */
  status: Extract<CronStatus, 'success' | 'partial'>;
  /** Set when `status` is `partial`. */
  message?: string;
  counts: FlowRepairCounts;
}

// ── Dates ───────────────────────────────────────────────────────────────────

/** `today` and the FLOW_REPAIR_LOOKBACK_DAYS calendar days before it, newest first. */
export function lookbackDates(today: string): string[] {
  const base = Date.parse(`${today}T00:00:00Z`);
  return Array.from({ length: FLOW_REPAIR_LOOKBACK_DAYS + 1 }, (_, i) =>
    new Date(base - i * 86_400_000).toISOString().slice(0, 10),
  );
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * The ticker-days that hold a NULL-flow fire at or after that day's open, over
 * `dates` (newest first). The open of each date comes from `ctSessionBounds`
 * (one home for the session window) and is joined in as a small unnest, so the
 * only table predicate on the fire table's date is the range, which the date
 * index serves; the NULL test and the open are filters over those few days.
 * The result is bounded by the fire universe times the lookback.
 */
export async function selectNullFlowGroups(
  sql: Sql,
  table: FlowRepairTable,
  dates: readonly string[],
): Promise<Group[]> {
  const from = dates.at(-1)!;
  const to = dates[0]!;
  const opens = dates.map((d) => ctSessionBounds(d).min);
  const rows = (
    table === 'lottery'
      ? await sql`
          SELECT f.underlying_symbol AS ticker, f.date::text AS date,
                 COUNT(*)::int AS n_rows
            FROM lottery_finder_fires f
            JOIN unnest(${[...dates]}::date[], ${opens}::timestamptz[])
                 AS d(date, open_at) ON f.date = d.date
           WHERE f.date >= ${from}::date AND f.date <= ${to}::date
             AND f.cum_ncp_at_fire IS NULL
             AND f.trigger_time_ct >= d.open_at
           GROUP BY f.underlying_symbol, f.date
           ORDER BY f.date DESC, COUNT(*) DESC, f.underlying_symbol`
      : await sql`
          SELECT f.underlying_symbol AS ticker, f.date::text AS date,
                 COUNT(*)::int AS n_rows
            FROM silent_boom_alerts f
            JOIN unnest(${[...dates]}::date[], ${opens}::timestamptz[])
                 AS d(date, open_at) ON f.date = d.date
           WHERE f.date >= ${from}::date AND f.date <= ${to}::date
             AND f.cum_ncp_at_fire IS NULL
             AND f.bucket_ct >= d.open_at
           GROUP BY f.underlying_symbol, f.date
           ORDER BY f.date DESC, COUNT(*) DESC, f.underlying_symbol`
  ) as Array<{ ticker: string; date: string; n_rows: number }>;
  return rows.map((r) => ({ ticker: r.ticker, date: r.date, nRows: r.n_rows }));
}

/** The NULL-flow fires of one group at or after the open, with their score state. */
async function readNullFires(
  sql: Sql,
  table: FlowRepairTable,
  group: Group,
): Promise<NullFire[]> {
  const open = ctSessionBounds(group.date).min;
  return (
    table === 'lottery'
      ? await sql`
          SELECT f.id::text AS id, f.trigger_time_ct AS at, f.tod,
                 f.dte::int AS dte, f.option_type,
                 f.trigger_vol_to_oi_window::float8 AS trigger_vol_to_oi_window,
                 f.gamma_at_trigger::float8 AS gamma_at_trigger,
                 f.trigger_ask_pct::float8 AS trigger_ask_pct,
                 f.score, f.score_version
            FROM lottery_finder_fires f
           WHERE f.underlying_symbol = ${group.ticker}
             AND f.date = ${group.date}::date
             AND f.cum_ncp_at_fire IS NULL
             AND f.trigger_time_ct >= ${open}::timestamptz
           ORDER BY f.id`
      : await sql`
          SELECT f.id::text AS id, f.bucket_ct AS at
            FROM silent_boom_alerts f
           WHERE f.underlying_symbol = ${group.ticker}
             AND f.date = ${group.date}::date
             AND f.cum_ncp_at_fire IS NULL
             AND f.bucket_ct >= ${open}::timestamptz
           ORDER BY f.id`
  ) as NullFire[];
}

/** Which of `ids` still have NULL flow: the planned rows a write did not land. */
async function stillNullIds(
  sql: Sql,
  table: FlowRepairTable,
  ids: readonly string[],
): Promise<Set<string>> {
  const rows = (
    table === 'lottery'
      ? await sql`
          SELECT id::text AS id FROM lottery_finder_fires
           WHERE id = ANY(${[...ids]}::bigint[]) AND cum_ncp_at_fire IS NULL`
      : await sql`
          SELECT id::text AS id FROM silent_boom_alerts
           WHERE id = ANY(${[...ids]}::bigint[]) AND cum_ncp_at_fire IS NULL`
  ) as Array<{ id: string }>;
  return new Set(rows.map((r) => String(r.id)));
}

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * ONE statement per chunk. Conditional on the flow still being NULL, so a value
 * another writer stored is never overwritten. A lottery row with a `toVersion`
 * also needs the score and the tag it was read with, and the `active` pointer
 * still naming `toVersion`; one that fails that is not written at all (neither
 * flow nor score), so a later slot repairs it whole. Returns the ids written.
 */
async function writeChunk(
  sql: Sql,
  table: FlowRepairTable,
  chunk: readonly Planned[],
): Promise<string[]> {
  const ids = chunk.map((p) => p.id);
  const ncp = chunk.map((p) => p.ncp);
  const npp = chunk.map((p) => p.npp);
  const rows = (await withDbRetry(
    () =>
      table === 'lottery'
        ? sql`
            UPDATE lottery_finder_fires AS f
               SET cum_ncp_at_fire = u.ncp,
                   cum_npp_at_fire = u.npp,
                   score = CASE WHEN u.to_version IS NULL
                                THEN f.score ELSE u.to_score END,
                   score_version = COALESCE(u.to_version, f.score_version)
              FROM unnest(${ids}::bigint[], ${ncp}::numeric[], ${npp}::numeric[],
                          ${chunk.map((p) => p.toScore)}::int[],
                          ${chunk.map((p) => p.toVersion)}::text[],
                          ${chunk.map((p) => p.fromVersion)}::text[])
                   AS u(id, ncp, npp, to_score, to_version, from_version)
             WHERE f.id = u.id
               AND f.cum_ncp_at_fire IS NULL
               AND (u.to_version IS NULL
                    OR (f.score IS NULL
                        AND f.score_version IS NOT DISTINCT FROM u.from_version
                        AND EXISTS (SELECT 1 FROM lottery_score_pointers p
                                     WHERE p.name = 'active'
                                       AND p.version = u.to_version)))
            RETURNING f.id::text AS id`
        : sql`
            UPDATE silent_boom_alerts AS f
               SET cum_ncp_at_fire = u.ncp, cum_npp_at_fire = u.npp
              FROM unnest(${ids}::bigint[], ${ncp}::numeric[], ${npp}::numeric[])
                   AS u(id, ncp, npp)
             WHERE f.id = u.id AND f.cum_ncp_at_fire IS NULL
            RETURNING f.id::text AS id`,
    2,
    20_000,
  )) as Array<{ id: string }>;
  return rows.map((r) => String(r.id));
}

// ── One ticker-day ──────────────────────────────────────────────────────────

const toMs = (v: Date | string): number =>
  v instanceof Date ? v.getTime() : new Date(v).getTime();

/**
 * What the write should do for one fire that has a flow value: flow only, or
 * flow plus the V2 score and the active tag. Updates `outcome`'s score counts
 * for the cases that are decided here (left, skipped).
 */
function planFire(
  table: FlowRepairTable,
  fire: NullFire,
  group: Group,
  flow: { ncp: number; npp: number },
  active: VersionedWeights | null,
  outcome: GroupOutcome,
): Planned {
  const flowOnly: Planned = {
    id: fire.id,
    ncp: flow.ncp,
    npp: flow.npp,
    fromVersion: fire.score_version ?? null,
    toVersion: null,
    toScore: null,
  };
  if (table !== 'lottery') return flowOnly;
  // A fire from before the seed weights was scored with older weights, and one
  // that already has a score is not the NULL-score kind this repair is for.
  if (group.date < SEED_WEIGHTS_LIVE_FROM || fire.score != null) {
    outcome.scoreLeft += 1;
    return flowOnly;
  }
  if (active == null) {
    outcome.rescoreSkipped += 1;
    return flowOnly;
  }
  const score = rescoreRow(active.weights, {
    id: fire.id,
    date: group.date,
    underlying_symbol: group.ticker,
    tod: fire.tod ?? '',
    dte: fire.dte ?? 0,
    option_type: fire.option_type ?? 'C',
    trigger_vol_to_oi_window: fire.trigger_vol_to_oi_window ?? null,
    gamma_at_trigger: fire.gamma_at_trigger ?? null,
    trigger_ask_pct: fire.trigger_ask_pct ?? null,
    cum_ncp_at_fire: flow.ncp,
    cum_npp_at_fire: flow.npp,
    score_version: fire.score_version ?? null,
  });
  if (score === 'unscorable') {
    outcome.scoreLeft += 1;
    return flowOnly;
  }
  return { ...flowOnly, toVersion: active.version, toScore: score };
}

/**
 * Read one ticker-day's NULL fires and series, then write what the series gives
 * them. Never throws: a failed read or write comes back in `state` and `error`.
 */
async function repairGroup(
  sql: Sql,
  table: FlowRepairTable,
  group: Group,
  active: VersionedWeights | null,
): Promise<GroupOutcome> {
  let fires: NullFire[];
  let series: Awaited<ReturnType<typeof fetchTickerFlowSeries>>;
  try {
    fires = await withDbRetry(
      () => readNullFires(sql, table, group),
      2,
      10_000,
    );
    // Another run may have repaired the group since the selection.
    if (fires.length === 0) return emptyOutcome('done');
    series = await withDeadline(
      fetchTickerFlowSeries(sql, group.ticker, group.date),
      FLOW_SERIES_DEADLINE_MS,
      'ticker flow series',
    );
  } catch (error) {
    return { ...emptyOutcome('read-failed'), error };
  }

  const outcome = emptyOutcome('done');
  outcome.fires = fires.length;
  const planned: Planned[] = [];
  for (const fire of fires) {
    const { cumNcp, cumNpp } = flowAtFireTime(series, new Date(toMs(fire.at)));
    if (cumNcp == null || cumNpp == null) {
      outcome.noValue += 1;
      continue;
    }
    planned.push(
      planFire(
        table,
        fire,
        group,
        { ncp: cumNcp, npp: cumNpp },
        active,
        outcome,
      ),
    );
  }

  const byId = new Map(planned.map((p) => [p.id, p]));
  let resolved = 0;
  try {
    for (let i = 0; i < planned.length; i += WRITE_CHUNK) {
      const chunk = planned.slice(i, i + WRITE_CHUNK);
      const writtenIds = await writeChunk(sql, table, chunk);
      outcome.written += writtenIds.length;
      resolved += writtenIds.length;
      for (const id of writtenIds) {
        const p = byId.get(id);
        if (p?.toVersion == null) continue;
        if (p.toScore == null) outcome.scoredNull += 1;
        else outcome.scored += 1;
      }
      const landed = new Set(writtenIds);
      const missing = chunk.map((p) => p.id).filter((id) => !landed.has(id));
      if (missing.length > 0) {
        // Not written: either another writer filled it first, or a guard held
        // it back and it is still NULL. Only the second is left to repair.
        const open = await withDbRetry(
          () => stillNullIds(sql, table, missing),
          2,
          10_000,
        );
        outcome.notWritten += open.size;
        outcome.alreadyFilled += missing.length - open.size;
        resolved += missing.length;
      }
    }
  } catch (error) {
    // `resolved` is the rows known to be written, filled by someone else, or
    // still NULL; the rest (this chunk, if its statement or its check failed,
    // and every later one) may or may not have landed: count them as not written.
    outcome.notWritten += planned.length - resolved;
    return { ...outcome, state: 'write-failed', error };
  }
  return outcome;
}

// ── The step ────────────────────────────────────────────────────────────────

const isTransient = (err: unknown): boolean =>
  err instanceof DeadlineError || isRetryableDbError(err);

/**
 * Capture a failure once per kind per run. A transient one (a Neon blip, a read
 * past its deadline) is retried by the next slot and is a warning message, like
 * the repo's other transient DB failures; a genuine one is an exception.
 */
function captureFailure(
  job: string,
  table: FlowRepairTable,
  kind: 'select' | 'read' | 'write',
  err: unknown,
  count: number,
): void {
  const tags = { job, table, step: 'flow-repair', kind };
  const message = err instanceof Error ? err.message : String(err);
  if (isTransient(err)) {
    Sentry.captureMessage(`fire flow repair ${kind} failed (transient)`, {
      level: 'warning',
      tags,
      fingerprint: ['fire-flow-repair-failure', table, kind, 'transient'],
      extra: { error: message, failures: count },
    });
    return;
  }
  Sentry.captureException(err, { tags, extra: { failures: count } });
}

/** The cron has started its last slot of the day (a fixed UTC hour, see above). */
const isLastSlot = (startTimeMs: number): boolean =>
  new Date(startTimeMs).getUTCHours() >= FLOW_REPAIR_LAST_SLOT_UTC_HOUR;

function failureMessage(c: FlowRepairCounts): string {
  const parts: string[] = [];
  if (c.selectFailed) parts.push('the NULL-flow selection failed');
  if (c.groupsReadFailed > 0) {
    parts.push(`${c.groupsReadFailed} ticker-day(s) could not be read`);
  }
  if (c.groupsWriteFailed > 0) {
    parts.push(`${c.groupsWriteFailed} ticker-day(s) failed to write`);
  }
  if (c.rescoreSkipped > 0) {
    parts.push(
      `${c.rescoreSkipped} repaired fire(s) left without a score: the weights store could not be read`,
    );
  }
  if (c.lastSlot && c.residualFires > 0) {
    parts.push(
      `${c.residualFires} fire(s) of the day left without flow after the last slot`,
    );
  }
  return `flow repair: ${parts.join('; ')}`;
}

/**
 * Run the repair step for one table, from inside its enrich cron. A database or
 * series failure never throws: it is counted, captured and returned in the
 * outcome's status. (Only a bug in this module throws, and the cron's wrapper
 * reports that as an error.)
 *
 * `startTimeMs` is the handler start (`ctx.startTimeMs`): the deadline and the
 * last-slot test both measure from it. `today` is the cron's ET date.
 */
export async function repairNullFlow(
  sql: Sql,
  opts: {
    table: FlowRepairTable;
    /** The cron's job name, for the Sentry tags. */
    job: string;
    today: string;
    startTimeMs: number;
  },
): Promise<FlowRepairOutcome> {
  const { table, job, today, startTimeMs } = opts;
  const deadlineMs =
    startTimeMs + FLOW_REPAIR_CRON_MAX_DURATION_MS - FLOW_REPAIR_MARGIN_MS;
  const counts: FlowRepairCounts = {
    groups: 0,
    groupsDone: 0,
    groupsDeferred: 0,
    groupsReadFailed: 0,
    groupsWriteFailed: 0,
    fires: 0,
    written: 0,
    noValue: 0,
    alreadyFilled: 0,
    notWritten: 0,
    scored: 0,
    scoredNull: 0,
    scoreLeft: 0,
    rescoreSkipped: 0,
    residualFires: 0,
    residualGroups: 0,
    selectFailed: false,
    lastSlot: isLastSlot(startTimeMs),
  };

  let groups: Group[] = [];
  try {
    groups = await withDbRetry(
      () => selectNullFlowGroups(sql, table, lookbackDates(today)),
      2,
      10_000,
    );
  } catch (error) {
    counts.selectFailed = true;
    captureFailure(job, table, 'select', error, 1);
    logger.error(
      { err: error, job, table },
      'fire flow repair selection failed',
    );
  }
  counts.groups = groups.length;

  // The weights are read once, and only when a lottery row can need them. A
  // store the loader could not read (its seed fallback) is not used: the flow is
  // still written, the score is left, and the run says so.
  let active: VersionedWeights | null = null;
  if (table === 'lottery' && groups.length > 0) {
    try {
      active = await loadActive();
    } catch (err) {
      logger.warn(
        { err, job },
        'fire flow repair: weights store unreadable, repairing flow without re-scoring',
      );
    }
  }

  const residualSample: string[] = [];
  const failures = {
    read: { first: null as unknown, count: 0 },
    write: { first: null as unknown, count: 0 },
  };
  await mapWithConcurrency(groups, FLOW_REPAIR_CONCURRENCY, async (group) => {
    const outcome =
      Date.now() >= deadlineMs
        ? emptyOutcome('deferred')
        : await repairGroup(sql, table, group, active);
    counts.fires += outcome.fires;
    counts.written += outcome.written;
    counts.noValue += outcome.noValue;
    counts.alreadyFilled += outcome.alreadyFilled;
    counts.notWritten += outcome.notWritten;
    counts.scored += outcome.scored;
    counts.scoredNull += outcome.scoredNull;
    counts.scoreLeft += outcome.scoreLeft;
    counts.rescoreSkipped += outcome.rescoreSkipped;
    let leftFires = outcome.notWritten;
    switch (outcome.state) {
      case 'done':
        counts.groupsDone += 1;
        break;
      case 'deferred':
        counts.groupsDeferred += 1;
        leftFires = group.nRows;
        break;
      case 'read-failed':
        counts.groupsReadFailed += 1;
        failures.read.first ??= outcome.error;
        failures.read.count += 1;
        leftFires = group.nRows;
        break;
      case 'write-failed':
        counts.groupsWriteFailed += 1;
        failures.write.first ??= outcome.error;
        failures.write.count += 1;
        break;
    }
    // Only today's fires are alarmed on: an older date had its own last slot.
    if (group.date === today && leftFires > 0) {
      counts.residualFires += leftFires;
      counts.residualGroups += 1;
      if (residualSample.length < RESIDUAL_SAMPLE) {
        residualSample.push(`${group.ticker} (${outcome.state}, ${leftFires})`);
      }
    }
  });

  if (failures.read.count > 0) {
    captureFailure(
      job,
      table,
      'read',
      failures.read.first,
      failures.read.count,
    );
  }
  if (failures.write.count > 0) {
    captureFailure(
      job,
      table,
      'write',
      failures.write.first,
      failures.write.count,
    );
  }

  const alarm =
    counts.lastSlot && (counts.residualFires > 0 || counts.selectFailed);
  if (alarm) {
    Sentry.captureMessage(
      'Fire flow repair left fires without flow after the last slot of the day',
      {
        level: 'error',
        tags: { job, table, step: 'flow-repair' },
        fingerprint: ['fire-flow-repair-residual', table],
        extra: {
          date: today,
          residualFires: counts.residualFires,
          residualGroups: counts.residualGroups,
          selectFailed: counts.selectFailed,
          sample: residualSample,
        },
      },
    );
  }

  logger.info({ job, table, ...counts }, 'fire flow repair completed');

  const partial =
    counts.selectFailed ||
    counts.groupsReadFailed > 0 ||
    counts.groupsWriteFailed > 0 ||
    counts.rescoreSkipped > 0 ||
    alarm;
  return partial
    ? { status: 'partial', message: failureMessage(counts), counts }
    : { status: 'success', counts };
}

/** The worse of two cron statuses (`error` over `partial` over `success`). */
export function worseStatus(a: CronStatus, b: CronStatus): CronStatus {
  const rank: Record<CronStatus, number> = {
    success: 0,
    skipped: 0,
    partial: 1,
    error: 2,
  };
  return rank[b] > rank[a] ? b : a;
}
