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
 *   1. `selectNullFlowGroups`: ONE statement returning the NULL-flow fires of
 *      the current ET date and the FLOW_REPAIR_LOOKBACK_DAYS days before it, at
 *      or after that day's 08:30 CT open (a pre-open fire has no series to read
 *      and would be selected forever), with what the repair needs of each: its
 *      time, and for lottery the scorer inputs and the score state. They are
 *      grouped by ticker-day in memory. The date range is the leading column of
 *      `lottery_finder_fires_date_ts_idx (date DESC, trigger_time_ct DESC)` and
 *      `silent_boom_alerts_date_bucket_idx (date DESC, bucket_ct DESC)`, so
 *      the read touches only those days (the NULL test is a filter on them).
 *      Bounded: the rows are a subset of five days of fires (about 22,000
 *      lottery rows, about 1,250 silent boom rows on production: a few MB at
 *      the worst, none near Neon's 64 MiB response cap), normally a few dozen.
 *   2. For each group, FLOW_REPAIR_CONCURRENCY at a time: one
 *      `fetchTickerFlowSeries` (the Phase A rule: the WS rows of the day, or
 *      the history minutes only when it has no WS row) and `flowAtFireTime` per
 *      fire. A fire the series has no value for (before the ticker's first WS
 *      tick, or a ticker with no flow rows) has nothing to write: it stays NULL,
 *      as a healthy live run stores it, and it is not a failure. A series with
 *      no point at all (a ticker with no flow rows) is counted apart
 *      (`emptySeriesGroups`) and reported in the last slot, because on a ticker
 *      that normally has flow it means the flow tables are empty for the day.
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
 *      new version, and no row ends with flow but a stale score. Not re-scored
 *      (flow only): a fire from before SEED_WEIGHTS_LIVE_FROM (scored with older
 *      weights), a fire that already has a score, and a `tod` the weights do not
 *      know. If the weights store cannot be read (the loader's seed fallback),
 *      a fire that WOULD be re-scored is not written at all, neither flow nor
 *      score: a row given its flow alone is no longer selected, so its score
 *      would stay NULL for good. It is counted in `rescoreSkipped`, makes the run
 *      `partial`, and (for the cron's own date) counts as residual, so a later
 *      slot repairs it whole once the store reads again. The fires that need no
 *      weights (silent boom, pre-seed, already scored) are still written.
 *
 * Time budget. The step starts no new group once FLOW_REPAIR_MARGIN_MS before
 * the cron's maxDuration, measured from the handler start (the lottery tape pass
 * runs first and can take about 110 s). A group in flight when the deadline
 * passes finishes its series read and its first write chunk and starts no
 * further chunk (the deadline is checked before every chunk after the first; the
 * rows it left are deferred); a group not started is deferred; the next slot
 * picks both up. What a group can spend past the deadline: the series deadline
 * (FLOW_SERIES_DEADLINE_MS, 15 s) + one chunk's write (FLOW_REPAIR_WRITE_RETRIES
 * 1 retry at FLOW_REPAIR_WRITE_ATTEMPT_MS 10 s: 2 x 10 s + 1 s backoff = 21 s) +
 * the check of what the write left (no retry, 5 s) = 41 s, inside the 60 s
 * margin. A unit test measures it from these constants and the real
 * `withDbRetry`, and fails when it outgrows the margin. The selection and the
 * weights read run before any group and are not part of that bound, so a step
 * entered at or after the deadline (the pass before it ran long) runs neither,
 * nor anything else: it is `partial` with `skippedNoTime`, and in the day's last
 * slot it raises the residual alarm, as a failed selection does.
 *
 * Honest status (R4). A failed or skipped selection, a failed series read or
 * write makes the run `partial`. A failure is captured: a genuine error with
 * `captureException`, a transient one (a Neon blip, a read past its deadline)
 * with a warning message, the first of each kind per run. The run never reports
 * `success` over a failed write. The residual alarm fires only in the day's last
 * slot: one error-level Sentry message per table with a fixed fingerprint, when
 * a fire of that ET date is left whose series HAS a value at the fire but stayed
 * NULL (or was held back for the weights store), or whose ticker-day series
 * could not be read (error, deadline, or not started), or when the selection
 * failed or was skipped (the residual could not be evaluated). Fires before the
 * ticker's first WS tick and pre-open fires are NOT residual. Only the current
 * date counts: an older date was alarmed at its own last slot. The same slot
 * sends one warning message (fingerprint
 * `['fire-flow-repair-empty-series', table]`) when a ticker-day of that date has
 * an empty series, and the alarm carries that count in its extra.
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

/**
 * The step starts no new group in the last 60 s before the cron's maxDuration.
 * A group already running finishes inside it: its worst case past the deadline
 * is `FLOW_SERIES_DEADLINE_MS` + one write chunk + the check on it, from the four
 * constants below (41 s today; `fire-flow-repair.test.ts` fails if it passes 60).
 */
export const FLOW_REPAIR_MARGIN_MS = 60_000;

/**
 * The write's own retry budget, `withDbRetry(fn, retries, perAttemptTimeoutMs)`:
 * one retry, 10 s an attempt, so 2 x 10 s + the 1 s backoff = 21 s at the very
 * worst. The default (2 retries) with the old 20 s cap could run 63 s alone.
 */
export const FLOW_REPAIR_WRITE_RETRIES = 1;
export const FLOW_REPAIR_WRITE_ATTEMPT_MS = 10_000;

/**
 * The check of what a short write left (`stillNullIds`): no retry, 5 s. A check
 * that fails is a failed write for the group, which the next slot redoes.
 */
export const FLOW_REPAIR_CHECK_RETRIES = 0;
export const FLOW_REPAIR_CHECK_ATTEMPT_MS = 5_000;

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

/** A NULL-flow fire of either table: what the flow lookup needs. */
interface BoomFire {
  id: string;
  at: Date | string;
}

/**
 * A NULL-flow lottery fire: the flow lookup's `at`, the columns the scorer
 * takes, and the score state now. `tod`, `dte` and `option_type` are NOT NULL
 * columns of `lottery_finder_fires` (migration #110), so nothing defaults them.
 */
interface LotteryFire extends BoomFire {
  tod: string;
  dte: number;
  option_type: 'C' | 'P';
  trigger_vol_to_oi_window: number | null;
  gamma_at_trigger: number | null;
  trigger_ask_pct: number | null;
  score: number | null;
  score_version: string | null;
}

type NullFire = BoomFire | LotteryFire;

/** Only a lottery fire has a score to give (silent boom alerts carry none). */
const isLotteryFire = (fire: NullFire): fire is LotteryFire =>
  'score_version' in fire;

/** The NULL-flow fires of one ticker-day, as the selection returned them. */
interface Group {
  ticker: string;
  /** `YYYY-MM-DD` */
  date: string;
  fires: NullFire[];
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
  /** The group's fires, when its series has no point at all; else 0. */
  emptySeriesFires: number;
  /** Fires of the group this run left NULL that a later slot could repair. */
  left: number;
}

function emptyOutcome(state: GroupOutcome['state'], left = 0): GroupOutcome {
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
    emptySeriesFires: 0,
    left,
  };
}

/** The counts of one run of one table, as `metadata.flowRepair`. */
export interface FlowRepairCounts {
  /** Ticker-days with a NULL-flow fire at or after the open, newest first. */
  groups: number;
  groupsDone: number;
  /**
   * Not started, or cut short between write chunks, because the deadline
   * passed: the next slot picks them up.
   */
  groupsDeferred: number;
  groupsReadFailed: number;
  groupsWriteFailed: number;
  /** NULL-flow fires in the groups that were read. */
  fires: number;
  /** Rows the write landed (RETURNING). */
  written: number;
  /** Fires the series has no value for: nothing to write, not a failure. */
  noValue: number;
  /**
   * Planned rows another writer filled between the read and the write. Also the
   * rows of a write attempt that timed out, was abandoned (not cancelled) and
   * committed after all: the retry then finds them filled. `written`, `scored`
   * and `scoredNull` undercount by those rows; the rows themselves are right.
   */
  alreadyFilled: number;
  /** Planned rows still NULL after the write (a guard held them back). */
  notWritten: number;
  /**
   * Lottery rows that went from score NULL to a score. Take-It
   * (`takeit_prob`, `takeit_features`, `takeit_model_version`) and a co-firing
   * neighbour's `cluster_bonus` were computed when this row's score was NULL and
   * are left as they were: this count is exactly the rows they are stale for.
   */
  scored: number;
  /** Lottery rows given score NULL (not aligned) and the active tag. */
  scoredNull: number;
  /** Lottery rows written with their score left: pre-seed, already scored, unknown tod. */
  scoreLeft: number;
  /**
   * Lottery fires NOT written (flow included) because the weights store could
   * not be read and they would have been re-scored; a later slot repairs them.
   */
  rescoreSkipped: number;
  /** Ticker-days whose series has no point at all (any date in the lookback). */
  emptySeriesGroups: number;
  /** The fires of those ticker-days. */
  emptySeriesFires: number;
  /** Fires of today's date still without flow that a later slot could repair. */
  residualFires: number;
  residualGroups: number;
  /** The selection query failed: nothing was repaired. */
  selectFailed: boolean;
  /**
   * The step was entered at or after its deadline (the pass before it used the
   * time), so it ran no statement at all: nothing was selected or repaired.
   */
  skippedNoTime: boolean;
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
 * The NULL-flow fires at or after their day's open, over `dates` (newest
 * first), grouped by ticker-day: the date, then the most NULL fires, then the
 * ticker, so the groups worth the most run first. One statement for every group
 * (R5: nothing is read per group). The open of each date comes from
 * `ctSessionBounds` (one home for the session window) and is joined in as a
 * small unnest, so the only table predicate on the fire table's date is the
 * range, which the date index serves; the NULL test and the open are filters
 * over those few days. The rows are bounded by the fire universe times the
 * lookback (see the header).
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
                 f.id::text AS id, f.trigger_time_ct AS at, f.tod,
                 f.dte::int AS dte, f.option_type,
                 f.trigger_vol_to_oi_window::float8 AS trigger_vol_to_oi_window,
                 f.gamma_at_trigger::float8 AS gamma_at_trigger,
                 f.trigger_ask_pct::float8 AS trigger_ask_pct,
                 f.score, f.score_version
            FROM lottery_finder_fires f
            JOIN unnest(${[...dates]}::date[], ${opens}::timestamptz[])
                 AS d(date, open_at) ON f.date = d.date
           WHERE f.date >= ${from}::date AND f.date <= ${to}::date
             AND f.cum_ncp_at_fire IS NULL
             AND f.trigger_time_ct >= d.open_at
           ORDER BY f.date DESC, f.underlying_symbol, f.id`
      : await sql`
          SELECT f.underlying_symbol AS ticker, f.date::text AS date,
                 f.id::text AS id, f.bucket_ct AS at
            FROM silent_boom_alerts f
            JOIN unnest(${[...dates]}::date[], ${opens}::timestamptz[])
                 AS d(date, open_at) ON f.date = d.date
           WHERE f.date >= ${from}::date AND f.date <= ${to}::date
             AND f.cum_ncp_at_fire IS NULL
             AND f.bucket_ct >= d.open_at
           ORDER BY f.date DESC, f.underlying_symbol, f.id`
  ) as Array<{ ticker: string; date: string } & NullFire>;

  // The rows arrive ordered by ticker-day, so a group is a run of equal keys.
  const groups: Group[] = [];
  for (const { ticker, date, ...fire } of rows) {
    const last = groups.at(-1);
    if (last?.ticker === ticker && last.date === date) last.fires.push(fire);
    else groups.push({ ticker, date, fires: [fire] });
  }
  return groups.sort(
    (a, b) =>
      b.date.localeCompare(a.date) ||
      b.fires.length - a.fires.length ||
      a.ticker.localeCompare(b.ticker),
  );
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
 *
 * Retry: FLOW_REPAIR_WRITE_RETRIES at FLOW_REPAIR_WRITE_ATTEMPT_MS an attempt.
 * `withDbRetry`'s per-attempt timeout abandons a request, it does not cancel it.
 * An abandoned attempt that commits after all leaves the retry nothing to write:
 * its rows are no longer NULL, so the check that follows counts them as
 * `alreadyFilled` and `written` undercounts them (the rows are right).
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
    FLOW_REPAIR_WRITE_RETRIES,
    FLOW_REPAIR_WRITE_ATTEMPT_MS,
  )) as Array<{ id: string }>;
  return rows.map((r) => String(r.id));
}

// ── One ticker-day ──────────────────────────────────────────────────────────

const toMs = (v: Date | string): number =>
  v instanceof Date ? v.getTime() : new Date(v).getTime();

/**
 * What the write should do for one fire that has a flow value: flow only, flow
 * plus the V2 score and the active tag, or (null) nothing at all. Updates
 * `outcome`'s score counts for the cases that are decided here (left, skipped).
 *
 * Null is a fire that WOULD be re-scored while the weights are not known
 * (`active` null, the store unreadable): its flow is held back too, because a
 * row given its flow alone is not selected again and would keep a NULL score
 * for good. A later slot, with the store readable, writes all three together.
 */
function planFire(
  fire: NullFire,
  group: Group,
  flow: { ncp: number; npp: number },
  active: VersionedWeights | null,
  outcome: GroupOutcome,
): Planned | null {
  const flowOnly: Planned = {
    id: fire.id,
    ncp: flow.ncp,
    npp: flow.npp,
    fromVersion: null,
    toVersion: null,
    toScore: null,
  };
  if (!isLotteryFire(fire)) return flowOnly;
  // A fire from before the seed weights was scored with older weights, and one
  // that already has a score is not the NULL-score kind this repair is for.
  if (group.date < SEED_WEIGHTS_LIVE_FROM || fire.score != null) {
    outcome.scoreLeft += 1;
    return flowOnly;
  }
  if (active == null) {
    outcome.rescoreSkipped += 1;
    return null;
  }
  const score = rescoreRow(active.weights, {
    id: fire.id,
    date: group.date,
    underlying_symbol: group.ticker,
    tod: fire.tod,
    dte: fire.dte,
    option_type: fire.option_type,
    trigger_vol_to_oi_window: fire.trigger_vol_to_oi_window,
    gamma_at_trigger: fire.gamma_at_trigger,
    trigger_ask_pct: fire.trigger_ask_pct,
    cum_ncp_at_fire: flow.ncp,
    cum_npp_at_fire: flow.npp,
    score_version: fire.score_version,
  });
  if (score === 'unscorable') {
    outcome.scoreLeft += 1;
    return flowOnly;
  }
  return {
    ...flowOnly,
    fromVersion: fire.score_version,
    toVersion: active.version,
    toScore: score,
  };
}

/**
 * Read one ticker-day's series, then write what it gives the group's fires.
 * A failed read or write does not throw: it comes back in `state` and `error`.
 * The planning between the two (`flowAtFireTime`, `planFire`) is outside both
 * guards on purpose: a throw there is a bug (a series of the wrong shape, a fire
 * row the scorer cannot take), not a database or network failure, so it
 * propagates out of this function and out of `repairNullFlow` instead of being
 * counted as one. The cron captures it (tags `step: flow-repair`) and the run
 * is an `error`.
 * `deadlineMs` is checked before every write chunk after the first, so a big
 * group cannot run on past the margin (see the header).
 */
async function repairGroup(
  sql: Sql,
  table: FlowRepairTable,
  group: Group,
  active: VersionedWeights | null,
  deadlineMs: number,
): Promise<GroupOutcome> {
  const { fires } = group;
  let series: Awaited<ReturnType<typeof fetchTickerFlowSeries>>;
  try {
    series = await withDeadline(
      fetchTickerFlowSeries(sql, group.ticker, group.date),
      FLOW_SERIES_DEADLINE_MS,
      'ticker flow series',
    );
  } catch (error) {
    return { ...emptyOutcome('read-failed', fires.length), error };
  }

  const outcome = emptyOutcome('done');
  outcome.fires = fires.length;
  if (series.ts.length === 0) outcome.emptySeriesFires = fires.length;
  const planned: Planned[] = [];
  for (const fire of fires) {
    const { cumNcp, cumNpp } = flowAtFireTime(series, new Date(toMs(fire.at)));
    if (cumNcp == null || cumNpp == null) {
      outcome.noValue += 1;
      continue;
    }
    const plan = planFire(
      fire,
      group,
      { ncp: cumNcp, npp: cumNpp },
      active,
      outcome,
    );
    if (plan != null) planned.push(plan);
  }

  const byId = new Map(planned.map((p) => [p.id, p]));
  let resolved = 0;
  let deferredRows = 0;
  try {
    for (let i = 0; i < planned.length; i += WRITE_CHUNK) {
      if (i > 0 && Date.now() >= deadlineMs) {
        // The budget is spent: the rows of the chunks not started wait for the
        // next slot. They are left, not failed.
        deferredRows = planned.length - i;
        break;
      }
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
          FLOW_REPAIR_CHECK_RETRIES,
          FLOW_REPAIR_CHECK_ATTEMPT_MS,
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
    outcome.left = outcome.notWritten + outcome.rescoreSkipped;
    return { ...outcome, state: 'write-failed', error };
  }
  outcome.left = outcome.notWritten + outcome.rescoreSkipped + deferredRows;
  if (deferredRows > 0) outcome.state = 'deferred';
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
  // Nothing else ran, so nothing else can be counted.
  if (c.skippedNoTime) return 'flow repair skipped: the pass left no time';
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
      `${c.rescoreSkipped} fire(s) left without flow or score until the next slot: the weights store could not be read`,
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
 * outcome's status. (Only a bug in this module throws, from the planning in
 * `repairGroup`; the cron captures it with `step: flow-repair` and reports the
 * run as an error, and a tape-pass error stays the run's error.)
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
    emptySeriesGroups: 0,
    emptySeriesFires: 0,
    residualFires: 0,
    residualGroups: 0,
    selectFailed: false,
    // The selection and the weights read are not part of the margin's bound
    // (see the header), so a step entered with the deadline already passed
    // starts neither: the next slot picks everything up.
    skippedNoTime: Date.now() >= deadlineMs,
    lastSlot: isLastSlot(startTimeMs),
  };

  let groups: Group[] = [];
  if (counts.skippedNoTime) {
    logger.warn(
      { job, table },
      'fire flow repair skipped: the pass left no time',
    );
  } else {
    try {
      // One retry, 10 s an attempt: it runs once, before any group, so it is
      // not part of the margin's bound, and it returns rows, not just counts.
      groups = await withDbRetry(
        () => selectNullFlowGroups(sql, table, lookbackDates(today)),
        1,
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
  }
  counts.groups = groups.length;

  // The weights are read once, and only when a lottery row can need them. A
  // store the loader could not read (its seed fallback) is not used: the fires
  // that would be re-scored are held back whole (flow and score together), and
  // the run says so. The fires that need no weights are still written.
  let active: VersionedWeights | null = null;
  if (table === 'lottery' && groups.length > 0) {
    try {
      active = await loadActive();
    } catch (err) {
      logger.warn(
        { err, job },
        'fire flow repair: weights store unreadable, holding back the fires it would re-score',
      );
    }
  }

  const residualSample: string[] = [];
  const emptySample: string[] = [];
  // Today's ticker-days with no flow series at all, for the last slot's report.
  const emptyToday = { groups: 0, fires: 0 };
  const failures = {
    read: { first: null as unknown, count: 0 },
    write: { first: null as unknown, count: 0 },
  };
  await mapWithConcurrency(groups, FLOW_REPAIR_CONCURRENCY, async (group) => {
    const outcome =
      Date.now() >= deadlineMs
        ? emptyOutcome('deferred', group.fires.length)
        : await repairGroup(sql, table, group, active, deadlineMs);
    counts.fires += outcome.fires;
    counts.written += outcome.written;
    counts.noValue += outcome.noValue;
    counts.alreadyFilled += outcome.alreadyFilled;
    counts.notWritten += outcome.notWritten;
    counts.scored += outcome.scored;
    counts.scoredNull += outcome.scoredNull;
    counts.scoreLeft += outcome.scoreLeft;
    counts.rescoreSkipped += outcome.rescoreSkipped;
    switch (outcome.state) {
      case 'done':
        counts.groupsDone += 1;
        break;
      case 'deferred':
        counts.groupsDeferred += 1;
        break;
      case 'read-failed':
        counts.groupsReadFailed += 1;
        failures.read.first ??= outcome.error;
        failures.read.count += 1;
        break;
      case 'write-failed':
        counts.groupsWriteFailed += 1;
        failures.write.first ??= outcome.error;
        failures.write.count += 1;
        break;
    }
    if (outcome.emptySeriesFires > 0) {
      counts.emptySeriesGroups += 1;
      counts.emptySeriesFires += outcome.emptySeriesFires;
      if (group.date === today) {
        emptyToday.groups += 1;
        emptyToday.fires += outcome.emptySeriesFires;
        if (emptySample.length < RESIDUAL_SAMPLE) {
          emptySample.push(`${group.ticker} (${outcome.emptySeriesFires})`);
        }
      }
    }
    // Only today's fires are alarmed on: an older date had its own last slot.
    if (group.date === today && outcome.left > 0) {
      counts.residualFires += outcome.left;
      counts.residualGroups += 1;
      if (residualSample.length < RESIDUAL_SAMPLE) {
        residualSample.push(
          `${group.ticker} (${outcome.state}, ${outcome.left})`,
        );
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

  // A selection that failed or never ran leaves the residual unknown, so in the
  // last slot both raise the alarm.
  const alarm =
    counts.lastSlot &&
    (counts.residualFires > 0 || counts.selectFailed || counts.skippedNoTime);
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
          skippedNoTime: counts.skippedNoTime,
          emptySeriesGroups: emptyToday.groups,
          emptySeriesFires: emptyToday.fires,
          sample: residualSample,
        },
      },
    );
  }

  // A ticker-day with no flow row at all is not residual (nothing can be
  // written), but on a ticker that normally has flow it means the flow tables
  // are empty for the day, which a count in a cron's metadata would not show.
  if (counts.lastSlot && emptyToday.groups > 0) {
    Sentry.captureMessage(
      'Fire flow repair found ticker-days with no flow at the last slot of the day',
      {
        level: 'warning',
        tags: { job, table, step: 'flow-repair' },
        fingerprint: ['fire-flow-repair-empty-series', table],
        extra: {
          date: today,
          emptySeriesGroups: emptyToday.groups,
          emptySeriesFires: emptyToday.fires,
          sample: emptySample,
        },
      },
    );
  }

  logger.info({ job, table, ...counts }, 'fire flow repair completed');

  const partial =
    counts.selectFailed ||
    counts.skippedNoTime ||
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
