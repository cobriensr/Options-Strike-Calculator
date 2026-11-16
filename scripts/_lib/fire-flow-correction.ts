/**
 * Correct the fires whose stored `cum_ncp_at_fire` / `cum_npp_at_fire` were
 * written DOUBLED by a post-close reader. Spec:
 * docs/superpowers/specs/lottery-flow-repair-and-indexes-2026-11-15.md.
 *
 * The defect. The series the flow-at-fire values come from was a UNION ALL of
 * `ws_net_flow_per_ticker` (one row per tick, `ts` with milliseconds) and
 * `net_flow_per_ticker_history` (one row per minute, `ts` on the minute, loaded
 * at 21:25 UTC), with DISTINCT ON (ts). After the close both tables hold the
 * same flow and the sum counted it twice. A live detector run is unaffected
 * (history for today is empty then), so a live-written value is right, and a
 * value written after the close, by `backfill-ticker-flow-at-fire.mjs` (2,159
 * rows on 2026-11-15) or a replay, holds about twice the flow.
 *
 * What a row is judged against. For each ticker-day with fires in scope the
 * script reads:
 *   - the FIXED value at each fire: `fetchTickerFlowSeries` +
 *     `flowAtFireTime`, the library the detectors use, which is WS-only for a
 *     ticker-day with WS rows;
 *   - the DOUBLED candidates at each fire: the legacy union (WS first,
 *     DISTINCT ON (ts), what the old code stored) and the WS sum plus the
 *     history sum. They differ only when a WS tick lands on an exact minute
 *     stamp, which merges that one pair.
 * A row is `correct` when both stored columns equal the fixed value, `doubled`
 * when the ticker-day has WS rows and both equal a doubled candidate (and not
 * the fixed value, and not the WS-only reading either), `lookahead` (below) and
 * `other` for everything else. Doubled rows are written with the fixed value.
 * "Equal" is within FLOW_TOLERANCE_USD, half a cent.
 *
 * Look-ahead. On a ticker-day with WS rows, a fire before that ticker's first
 * WS tick has no fixed value (live stored NULL). The old backfill wrote the
 * unshifted history sum with `ts <= fire` there: the history minutes up to and
 * including the fire's minute, the last of them still open at the fire, so up
 * to 59 s of flow after it. Only a fire in the session's first minute holds
 * nothing but that partial minute; a later fire before the ticker's first tick
 * also holds complete minutes. A stored value equal to that sum is `lookahead`,
 * and both flow columns are written NULL, as live stored them. It is its own
 * category in the counts, the per-date lines and the report. A stored value
 * that does not match the sum stays `other` / `no-fixed-value`. The WS gap read
 * below also covers these rows: it counts and lists the ones whose NULL leaves
 * out at least one complete nonzero history minute before the fire (none, when
 * every look-ahead fire is in the opening second).
 *
 * Scores (lottery only). The V2 score depends on flow only through alignment
 * (`isAlignedFire`; no flow at all is not aligned). For a corrected row whose
 * alignment did not change, the score and its tag are left alone. Aligned
 * before and not after (a doubled row now against the flow, or any look-ahead
 * row): the score becomes NULL and `score_version` becomes the active version,
 * as live scoring stores it (a NULL score with `active.version` bound, see
 * detect-lottery-fires.ts). A fire before SEED_WEIGHTS_LIVE_FROM gets the NULL
 * score too (NULL needs no weights) and keeps its tag. Not aligned before and
 * aligned after: the score is computed with the weights of the version the
 * `active` pointer names (`loadActive`, `rescoreRow`: the rescore's own
 * helpers) and written with `score_version` = that version, except for a fire
 * before SEED_WEIGHTS_LIVE_FROM, whose flow is corrected and score left (an
 * earlier fire was scored with older weights). `silent_boom_alerts` carries no
 * flow-derived score.
 *
 * WS gaps (visibility only; the corrected value stays WS-only, as live stored
 * it, and an owner decision on filling gaps from history is pending). For each
 * doubled row: the history minutes complete at the fire (`ts + 60 s <= fire`)
 * with a nonzero call or put premium and no WS tick in [ts, ts + 60 s), and
 * their summed flow. The report counts the doubled rows with at least one such
 * minute, the "material" ones (the gap flow exceeds 5% of the corrected flow on
 * either side) and, for lottery, those whose alignment the gap flow would flip.
 * The same reading is taken for each look-ahead row (a separate block: its
 * corrected flow is NULL, so there is no materiality or alignment to judge).
 * One extra query per ticker-day that has a doubled or a look-ahead row, never
 * one per fire; its probe of the WS table is bounded by the session, as the
 * series is.
 *
 * Writes. With `--apply` the plan is read in full first, an undo file is
 * written before the first UPDATE (and never over an existing file), and the
 * writes are batches of 500 through `unnest`, each guarded on the values the
 * plan was read on (both flow columns, the score and its tag; NULL compares as
 * a value, so a flow moving to or from NULL is guarded both ways), so a row any
 * other writer changed in between is skipped and a rerun finds nothing left. A
 * write that sets a new `score_version` also requires the `active` pointer to
 * still name it. `--undo-file` restores the old values, guarded on the row
 * still holding the values this run wrote.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { getDb } from '../../api/_lib/db.js';
import { isAlignedFire } from '../../api/_lib/lottery-score-weights-v2.js';
import type { LotteryWeights } from '../../api/_lib/lottery-weights-schema.js';
import {
  fetchTickerFlowSeries,
  flowAtFireTime,
} from '../../api/_lib/ticker-flow-snapshot.js';
import { mapWithConcurrency } from '../../api/_lib/uw-fetch.js';
import { ctSessionBounds } from '../../src/components/LotteryFinder/ct-window.js';
import {
  SEED_WEIGHTS_LIVE_FROM,
  loadActive,
  rescoreRow,
  type CandidateRow,
} from './lottery-v2-rescore.js';

type Sql = ReturnType<typeof getDb>;

/**
 * Two stored values are the same series when they differ by less than this:
 * half a cent. The premiums are cent-precision NUMERIC sums, so the same series
 * reads back exactly and two different series differ by a whole cent or more.
 */
export const FLOW_TOLERANCE_USD = 0.005;
/** The first day `ws_net_flow_per_ticker` has rows: nothing earlier can be doubled. */
export const WS_FIRST_DAY = '2026-05-04';
/** Rows per UPDATE (R5). */
const WRITE_CHUNK = 500;
/** Ticker-days read at once: as many as the detectors run in parallel. */
const GROUP_CONCURRENCY = 3;
/** Rows in each list (planned writes, material gaps, look-ahead gaps, other mismatch) unless `--list-limit` says otherwise. */
export const DEFAULT_LIST_LIMIT = 200;
export const UNDO_DIR = 'docs/tmp/fire-flow-correction';
/** One history row is one whole minute: it is complete 60 s after its stamp. */
const HISTORY_MINUTE_MS = 60_000;
/**
 * A WS gap is material when its flow exceeds this share of the corrected
 * (WS-only) flow on the call or the put side. An operating choice for the
 * report, not a methodology: nothing is written from it.
 */
export const MATERIAL_GAP_FRACTION = 0.05;

export type FireTable = 'lottery' | 'silentboom';

const TABLE_NAME: Record<FireTable, string> = {
  lottery: 'lottery_finder_fires',
  silentboom: 'silent_boom_alerts',
};

// ── Arguments ───────────────────────────────────────────────────────────────

export interface CliArgs {
  apply: boolean;
  /** `YYYY-MM-DD`; null only with `--help` or `--undo-file`. */
  since: string | null;
  undoFile: string | null;
  listLimit: number;
  envFile: string | null;
  help: boolean;
}

export const USAGE = `Usage: npx tsx scripts/correct-doubled-fire-flow.ts --since YYYY-MM-DD [options]
       npx tsx scripts/correct-doubled-fire-flow.ts --undo-file <file> [--apply]

Finds the fires whose cum_ncp_at_fire / cum_npp_at_fire were written doubled
(the WS tick rows plus the per-minute history rows, summed together) and
corrects them to the WS-only value a live run would have stored. Only a row
whose stored value matches the doubled value, and not the WS-only value, is
touched. A fire before its ticker's first WS tick, whose stored value is the
history sum up to the fire's minute (look-ahead), gets NULL flow, as live stored
it. For lottery fires whose alignment (call or put against the flow) flips, the
V2 score follows: NULL (tagged with the active version) if the fire is now
against the flow, a score from the active weights if it is now with it. Reports,
per table and per date, the rows doubled, look-ahead, already correct, and other
(left alone, listed), every planned write, and the WS gaps of the doubled rows
and of the look-ahead rows (visibility only: whether to fill them from history
is an open owner decision).

Options:
  --since <date>      first fire date to cover, YYYY-MM-DD (required; not before
                      ${WS_FIRST_DAY}, the first day the WS table has rows)
  --apply             write (without it: dry run, which writes nothing). An undo
                      file is written under ${UNDO_DIR}/ first
  --dry-run           the default, said aloud; contradicts --apply
  --undo-file <file>  restore the values an earlier --apply wrote (with --apply;
                      without it, only counts the file's rows)
  --list-limit <n>    rows to list under each of "planned writes", "material WS gaps",
                      "look-ahead WS gaps" and "other mismatch" (default
                      ${DEFAULT_LIST_LIMIT}; 0 lists none)
  --env-file <path>   .env.local to load (default: the nearest one up the tree)
  --help, -h          print this and exit`;

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

/** `--apply` is the only way to write; `--dry-run` just says the default aloud. */
export function parseArgs(argv: readonly string[]): CliArgs {
  let apply = false;
  let dryRun = false;
  let help = false;
  let since: string | null = null;
  let undoFile: string | null = null;
  let envFile: string | null = null;
  let listLimit = DEFAULT_LIST_LIMIT;
  const valueOf = (flag: string, i: number): string => {
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) {
      throw new Error(`${flag} needs a value`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    if (flag === '--apply') apply = true;
    else if (flag === '--dry-run') dryRun = true;
    else if (flag === '--help' || flag === '-h') help = true;
    else if (flag === '--since') {
      since = valueOf(flag, i);
      i += 1;
    } else if (flag === '--undo-file') {
      undoFile = valueOf(flag, i);
      i += 1;
    } else if (flag === '--env-file') {
      envFile = valueOf(flag, i);
      i += 1;
    } else if (flag === '--list-limit') {
      const value = valueOf(flag, i);
      if (!/^\d+$/.test(value)) {
        throw new Error('--list-limit needs a whole number');
      }
      listLimit = Number.parseInt(value, 10);
      i += 1;
    } else throw new Error(`unknown argument ${flag}`);
  }
  if (apply && dryRun) throw new Error('--apply and --dry-run contradict');
  const args: CliArgs = {
    apply,
    since,
    undoFile,
    listLimit,
    envFile,
    help,
  };
  if (help) return args;
  if (undoFile != null) {
    if (since != null) throw new Error('--undo-file and --since contradict');
    return args;
  }
  if (since == null) throw new Error('--since YYYY-MM-DD is required');
  if (!isIsoDate(since)) {
    throw new Error(`--since ${since} is not a YYYY-MM-DD date`);
  }
  if (since < WS_FIRST_DAY) {
    throw new Error(
      `--since ${since} is before ${WS_FIRST_DAY}, the first day the WS flow table has rows: nothing earlier can be doubled`,
    );
  }
  return args;
}

// ── Judging one row ─────────────────────────────────────────────────────────

export interface Flow {
  ncp: number;
  npp: number;
}

/** The cumulative flow at one fire under each reading of the two tables. */
export interface LegacyAtFire {
  /** WS first, DISTINCT ON (ts): what the old code stored. */
  union: Flow | null;
  /** WS rows only. */
  ws: Flow | null;
  /** History rows only, minute-start stamps, as the old code counted them. */
  history: Flow | null;
}

export type OtherReason =
  /**
   * The fixed series has no value at the fire (empty, or before its first row)
   * and the stored value is not the look-ahead history sum.
   */
  | 'no-fixed-value'
  /** A ticker-day with no WS rows: not doubled, but holds up to 59 s of look-ahead. */
  | 'history-only-day'
  /** Matches neither the fixed value nor a doubled candidate. */
  | 'unmatched';

export type Verdict =
  | { kind: 'correct' }
  | { kind: 'doubled'; fixed: Flow }
  /**
   * A fire before the ticker's first WS tick, on a day with WS rows, holding
   * the history sum up to and including the fire's minute (the old backfill's
   * value). The fixed value is NULL, so the correction writes NULL.
   */
  | { kind: 'lookahead' }
  | { kind: 'other'; reason: OtherReason; fixed: Flow | null };

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < FLOW_TOLERANCE_USD;
}

function sameFlow(stored: Flow, other: Flow | null): boolean {
  return (
    other != null && near(stored.ncp, other.ncp) && near(stored.npp, other.npp)
  );
}

/** WS sum plus history sum at the fire, the brief's "doubled value". */
function wsPlusHistory(legacy: LegacyAtFire): Flow | null {
  if (legacy.ws == null && legacy.history == null) return null;
  return {
    ncp: (legacy.ws?.ncp ?? 0) + (legacy.history?.ncp ?? 0),
    npp: (legacy.ws?.npp ?? 0) + (legacy.history?.npp ?? 0),
  };
}

/**
 * Which kind of row this is. `fixed` is the value the fixed series gives at
 * the fire (null when it has none), `hasWs` whether the ticker-day has WS rows
 * in its session.
 */
export function classifyRow(input: {
  stored: Flow;
  fixed: Flow | null;
  hasWs: boolean;
  legacy: LegacyAtFire;
}): Verdict {
  const { stored, fixed, hasWs, legacy } = input;
  if (sameFlow(stored, fixed)) return { kind: 'correct' };
  if (fixed == null) {
    // No WS tick at or before the fire, so WS-only has nothing, and the history
    // sum with ts <= fire is what the old backfill wrote: the history minutes up
    // to and including the fire's minute. Only a fire in the session's first
    // minute holds nothing but that partial minute; a later fire before the
    // ticker's first tick also holds complete minutes. Only on a day with WS
    // rows; a history-only day has its own rule.
    if (hasWs && sameFlow(stored, legacy.history)) return { kind: 'lookahead' };
    return { kind: 'other', reason: 'no-fixed-value', fixed: null };
  }
  // A stored value equal to the WS-only reading is what a run that saw the
  // ticks the fixed read has not (or the other way round) holds: not doubled.
  if (
    hasWs &&
    !sameFlow(stored, legacy.ws) &&
    (sameFlow(stored, legacy.union) || sameFlow(stored, wsPlusHistory(legacy)))
  ) {
    return { kind: 'doubled', fixed };
  }
  if (
    !hasWs &&
    (sameFlow(stored, legacy.union) || sameFlow(stored, legacy.history))
  ) {
    return { kind: 'other', reason: 'history-only-day', fixed };
  }
  return { kind: 'other', reason: 'unmatched', fixed };
}

// ── Scores ──────────────────────────────────────────────────────────────────

export interface LotteryScoreInputs {
  /** The columns `rescoreRow` reads, with the flow as stored (the old value). */
  row: CandidateRow;
  /** `lottery_finder_fires.score` now. */
  score: number | null;
}

export type ScorePlan =
  /** Alignment did not change, or the score already is what live scoring gives. */
  | { kind: 'unchanged' }
  /**
   * Aligned before, against the flow (or without flow) now: NULL, tagged with
   * the active version, which is what live scoring stores for such a fire.
   */
  | { kind: 'nulled' }
  /**
   * The same for a fire before SEED_WEIGHTS_LIVE_FROM: NULL needs no weights,
   * and the tag is left, since the fire was scored under older ones.
   */
  | { kind: 'nulled-pre-seed' }
  /** With the flow now: the active version's score. */
  | { kind: 'set'; score: number }
  /** A fire from before SEED_WEIGHTS_LIVE_FROM that is now with the flow: left. */
  | { kind: 'left-pre-seed' }
  /** With the flow now, but the weights have no table for its `tod`. */
  | { kind: 'left-unscorable' };

/**
 * Whether a call or put fire is with the flow before the correction and after
 * it. A fixed flow of null (a look-ahead row) is not aligned.
 */
export function alignmentFlip(
  optionType: 'C' | 'P',
  stored: Flow,
  fixed: Flow | null,
): 'to-unaligned' | 'to-aligned' | null {
  const was = isAlignedFire(optionType, stored.ncp, stored.npp);
  const now = isAlignedFire(optionType, fixed?.ncp ?? null, fixed?.npp ?? null);
  if (was === now) return null;
  return now ? 'to-aligned' : 'to-unaligned';
}

/**
 * What the score does when the row's flow goes from the stored value (the
 * `cum_*` of `input.row`) to the fixed one (null: no flow, not aligned).
 */
export function planScore(
  weights: LotteryWeights,
  input: LotteryScoreInputs,
  fixed: Flow | null,
): ScorePlan {
  const { row, score } = input;
  const preSeed = row.date < SEED_WEIGHTS_LIVE_FROM;
  const flip = alignmentFlip(
    row.option_type,
    { ncp: row.cum_ncp_at_fire, npp: row.cum_npp_at_fire },
    fixed,
  );
  if (flip == null) return { kind: 'unchanged' };
  if (flip === 'to-unaligned') {
    if (score == null) return { kind: 'unchanged' };
    return preSeed ? { kind: 'nulled-pre-seed' } : { kind: 'nulled' };
  }
  if (preSeed) return { kind: 'left-pre-seed' };
  // Aligned after means there is a flow to score with.
  const rescored = rescoreRow(weights, {
    ...row,
    cum_ncp_at_fire: fixed!.ncp,
    cum_npp_at_fire: fixed!.npp,
  });
  if (rescored === 'unscorable') return { kind: 'left-unscorable' };
  if (rescored == null || rescored === score) return { kind: 'unchanged' };
  return { kind: 'set', score: rescored };
}

// ── The plan ────────────────────────────────────────────────────────────────

/**
 * The four stored values a write replaces, as exact text (null is NULL). The
 * flow is null in the `new` side of a look-ahead row.
 */
export interface Stored {
  ncp: string | null;
  npp: string | null;
  score: number | null;
  version: string | null;
}

// ── WS gaps ─────────────────────────────────────────────────────────────────

/** One history minute that has flow and no WS tick: `ts` is the minute's start. */
export interface GapMinute {
  ts: number;
  ncp: number;
  npp: number;
}

/** The gap minutes complete at one fire, and their flow. */
export interface GapReading {
  minutes: number;
  ncp: number;
  npp: number;
}

export interface GapInfo extends GapReading {
  /** The gap flow exceeds MATERIAL_GAP_FRACTION of the corrected flow, either side. */
  material: boolean;
  /** Lottery, material gaps only: adding the gap flow would flip the alignment. */
  flips: boolean | null;
}

/**
 * The gap minutes that were complete at the fire. A history row is a whole
 * minute, so it is reached once `ts + 60 s <= fire`: the rule the series uses.
 */
export function gapAtFire(
  minutes: readonly GapMinute[],
  fireMs: number,
): GapReading {
  const reading: GapReading = { minutes: 0, ncp: 0, npp: 0 };
  for (const minute of minutes) {
    if (minute.ts + HISTORY_MINUTE_MS > fireMs) continue;
    reading.minutes += 1;
    reading.ncp += minute.ncp;
    reading.npp += minute.npp;
  }
  return reading;
}

/** Whether the gap flow exceeds MATERIAL_GAP_FRACTION of the corrected flow on the call or the put side. */
export function gapIsMaterial(gap: GapReading, corrected: Flow): boolean {
  return (
    Math.abs(gap.ncp) > MATERIAL_GAP_FRACTION * Math.abs(corrected.ncp) ||
    Math.abs(gap.npp) > MATERIAL_GAP_FRACTION * Math.abs(corrected.npp)
  );
}

/** Whether adding the gap flow to the corrected flow changes a lottery fire's alignment. */
export function gapFlips(
  optionType: 'C' | 'P',
  corrected: Flow,
  gap: GapReading,
): boolean {
  return (
    isAlignedFire(optionType, corrected.ncp, corrected.npp) !==
    isAlignedFire(optionType, corrected.ncp + gap.ncp, corrected.npp + gap.npp)
  );
}

export type ChangeCategory = 'doubled' | 'lookahead';

export interface Change {
  table: FireTable;
  id: string;
  date: string;
  ticker: string;
  /** The fire instant, ISO 8601 UTC. */
  fireAt: string;
  category: ChangeCategory;
  old: Stored;
  new: Stored;
  /** Alignment flipped on the correction. */
  flipped: 'to-unaligned' | 'to-aligned' | null;
  score: ScorePlan['kind'] | 'none';
  /** A doubled row's WS gap reading; null for look-ahead rows. */
  gap: GapInfo | null;
  /**
   * A look-ahead row's history minutes complete before the fire, the flow the
   * NULL leaves out (no WS tick can lie in them: the ticker's first tick comes
   * after the fire); null for doubled rows, and for a look-ahead row whose gap
   * was not read.
   */
  lookaheadGap: GapReading | null;
}

export interface OtherRow {
  table: FireTable;
  id: string;
  date: string;
  ticker: string;
  reason: OtherReason;
  stored: Flow;
  fixed: Flow | null;
}

export interface Counts {
  correct: number;
  doubled: number;
  lookahead: number;
  other: number;
}

export interface Plan {
  /** Rows with stored flow in scope, per table. */
  scanned: Record<FireTable, number>;
  counts: Record<FireTable, Counts>;
  byDate: Map<string, Counts>;
  otherReasons: Map<OtherReason, number>;
  /** The first `listLimit` other-mismatch rows; the counts above are exact. */
  otherRows: OtherRow[];
  /** Planned writes: the doubled rows and the look-ahead rows. */
  changes: Change[];
}

function emptyCounts(): Counts {
  return { correct: 0, doubled: 0, lookahead: 0, other: 0 };
}

function emptyPlan(): Plan {
  return {
    scanned: { lottery: 0, silentboom: 0 },
    counts: { lottery: emptyCounts(), silentboom: emptyCounts() },
    byDate: new Map(),
    otherReasons: new Map(),
    otherRows: [],
    changes: [],
  };
}

/** A fire in scope: the stored flow as exact text plus what the score reads. */
export interface FireRow {
  table: FireTable;
  id: string;
  date: string;
  ticker: string;
  atMs: number;
  ncp: string;
  npp: string;
  /** Lottery only. */
  lottery: {
    optionType: 'C' | 'P';
    tod: string;
    dte: number;
    volOi: number | null;
    gamma: number | null;
    askPct: number | null;
    score: number | null;
    scoreVersion: string | null;
  } | null;
}

const numToText = (n: number): string => String(n);

function toCandidate(row: FireRow): CandidateRow {
  const lot = row.lottery!;
  return {
    id: row.id,
    date: row.date,
    underlying_symbol: row.ticker,
    tod: lot.tod,
    dte: lot.dte,
    option_type: lot.optionType,
    trigger_vol_to_oi_window: lot.volOi,
    gamma_at_trigger: lot.gamma,
    trigger_ask_pct: lot.askPct,
    cum_ncp_at_fire: Number(row.ncp),
    cum_npp_at_fire: Number(row.npp),
    score_version: lot.scoreVersion,
  };
}

/** One row, judged: what it holds, what it should hold, and its WS gap if it was read. */
export interface Judged {
  row: FireRow;
  verdict: Verdict;
  /** The stored flow as numbers (`row.ncp` / `row.npp` are the exact text). */
  stored: Flow;
  /** Doubled and look-ahead rows only. */
  gap: GapReading | null;
}

/** What turns a judged row into a planned write. */
export interface PlanContext {
  weights: LotteryWeights;
  /** The version a re-scored or NULLed lottery row is tagged with. */
  activeVersion: string;
  listLimit: number;
}

function gapInfo(row: FireRow, corrected: Flow, reading: GapReading): GapInfo {
  const material = gapIsMaterial(reading, corrected);
  return {
    ...reading,
    material,
    flips:
      material && row.lottery != null
        ? gapFlips(row.lottery.optionType, corrected, reading)
        : null,
  };
}

/** Fold one judged row into the plan. */
export function recordRow(
  plan: Plan,
  { row, verdict, stored, gap }: Judged,
  ctx: PlanContext,
): void {
  plan.scanned[row.table] += 1;
  const day = plan.byDate.get(row.date) ?? emptyCounts();
  plan.byDate.set(row.date, day);
  plan.counts[row.table][verdict.kind] += 1;
  day[verdict.kind] += 1;

  if (verdict.kind === 'other') {
    plan.otherReasons.set(
      verdict.reason,
      (plan.otherReasons.get(verdict.reason) ?? 0) + 1,
    );
    if (plan.otherRows.length < ctx.listLimit) {
      plan.otherRows.push({
        table: row.table,
        id: row.id,
        date: row.date,
        ticker: row.ticker,
        reason: verdict.reason,
        stored,
        fixed: verdict.fixed,
      });
    }
    return;
  }
  if (verdict.kind === 'correct') return;

  // The value the row moves to: the fixed flow, or none for look-ahead.
  const fixed = verdict.kind === 'doubled' ? verdict.fixed : null;
  const old: Stored = {
    ncp: row.ncp,
    npp: row.npp,
    score: row.lottery?.score ?? null,
    version: row.lottery?.scoreVersion ?? null,
  };
  const next: Stored = {
    ...old,
    ncp: fixed == null ? null : numToText(fixed.ncp),
    npp: fixed == null ? null : numToText(fixed.npp),
  };
  let flipped: Change['flipped'] = null;
  let scoreKind: Change['score'] = 'none';
  if (row.lottery != null) {
    const plain = toCandidate(row);
    flipped = alignmentFlip(plain.option_type, stored, fixed);
    const scorePlan = planScore(
      ctx.weights,
      { row: plain, score: row.lottery.score },
      fixed,
    );
    scoreKind = scorePlan.kind;
    if (scorePlan.kind === 'nulled') {
      next.score = null;
      next.version = ctx.activeVersion;
    }
    if (scorePlan.kind === 'nulled-pre-seed') next.score = null;
    if (scorePlan.kind === 'set') {
      next.score = scorePlan.score;
      next.version = ctx.activeVersion;
    }
  }
  plan.changes.push({
    table: row.table,
    id: row.id,
    date: row.date,
    ticker: row.ticker,
    fireAt: new Date(row.atMs).toISOString(),
    category: verdict.kind,
    old,
    new: next,
    flipped,
    score: scoreKind,
    gap: fixed != null && gap != null ? gapInfo(row, fixed, gap) : null,
    lookaheadGap: verdict.kind === 'lookahead' ? gap : null,
  });
}

// ── Listing the plan ────────────────────────────────────────────────────────

/**
 * The planned writes in the order the report lists them: by date, then table
 * (lottery first), then id. A copy: the plan itself is not reordered.
 */
export function orderPlanned(changes: readonly Change[]): Change[] {
  return [...changes].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.table.localeCompare(b.table) ||
      Number(a.id) - Number(b.id),
  );
}

/** A material-gap row, with what the report prints beside it. */
export interface GapRow {
  table: FireTable;
  id: string;
  date: string;
  ticker: string;
  minutes: number;
  gapNcp: number;
  gapNpp: number;
  /** The corrected (WS-only) flow. */
  ncp: number;
  npp: number;
  /** Lottery: whether the gap flow would flip the alignment; silent boom: null. */
  flips: boolean | null;
}

/**
 * A look-ahead row holding at least one complete, nonzero history minute
 * before the fire: flow the NULL it is corrected to leaves out.
 */
export interface LookaheadGapRow {
  table: FireTable;
  id: string;
  date: string;
  ticker: string;
  /** The fire instant, ISO 8601 UTC. */
  fireAt: string;
  minutes: number;
  gapNcp: number;
  gapNpp: number;
}

export interface GapSummary {
  /** Doubled rows whose gap was read. */
  doubled: Record<FireTable, number>;
  /** ... with at least one history minute that has no WS tick. */
  withGap: Record<FireTable, number>;
  /** ... whose gap flow exceeds MATERIAL_GAP_FRACTION of the corrected flow on a side. */
  material: Record<FireTable, number>;
  /** Material-gap lottery rows whose alignment the gap flow would flip. */
  flips: number;
  /** The look-ahead rows: a fire before its ticker's first WS tick. */
  lookahead: {
    /** Look-ahead rows whose gap was read. */
    read: Record<FireTable, number>;
    /** ... with at least one complete nonzero history minute before the fire. */
    withMinutes: Record<FireTable, number>;
    /** The first `listLimit` of those, in the order of `changes`. */
    rows: LookaheadGapRow[];
  };
  /** The first `listLimit` material rows, in the order of `changes`. */
  rows: GapRow[];
}

/**
 * The gap counts over the planned writes, the first `listLimit` material rows
 * of the doubled ones, and the first `listLimit` look-ahead rows that hold a
 * complete history minute before the fire.
 */
export function summarizeGaps(
  changes: readonly Change[],
  listLimit: number,
): GapSummary {
  const summary: GapSummary = {
    doubled: { lottery: 0, silentboom: 0 },
    withGap: { lottery: 0, silentboom: 0 },
    material: { lottery: 0, silentboom: 0 },
    flips: 0,
    lookahead: {
      read: { lottery: 0, silentboom: 0 },
      withMinutes: { lottery: 0, silentboom: 0 },
      rows: [],
    },
    rows: [],
  };
  for (const change of changes) {
    const { gap, lookaheadGap } = change;
    if (change.category === 'lookahead') {
      if (lookaheadGap == null) continue;
      summary.lookahead.read[change.table] += 1;
      if (lookaheadGap.minutes === 0) continue;
      summary.lookahead.withMinutes[change.table] += 1;
      if (summary.lookahead.rows.length < listLimit) {
        summary.lookahead.rows.push({
          table: change.table,
          id: change.id,
          date: change.date,
          ticker: change.ticker,
          fireAt: change.fireAt,
          minutes: lookaheadGap.minutes,
          gapNcp: lookaheadGap.ncp,
          gapNpp: lookaheadGap.npp,
        });
      }
      continue;
    }
    if (gap == null) continue;
    summary.doubled[change.table] += 1;
    if (gap.minutes > 0) summary.withGap[change.table] += 1;
    if (!gap.material) continue;
    summary.material[change.table] += 1;
    if (gap.flips === true) summary.flips += 1;
    if (summary.rows.length < listLimit) {
      summary.rows.push({
        table: change.table,
        id: change.id,
        date: change.date,
        ticker: change.ticker,
        minutes: gap.minutes,
        gapNcp: gap.ncp,
        gapNpp: gap.npp,
        ncp: Number(change.new.ncp),
        npp: Number(change.new.npp),
        flips: gap.flips,
      });
    }
  }
  return summary;
}

// ── Reads ───────────────────────────────────────────────────────────────────

type DbText = string | null;

/** Every date on or after `since` that has a fire with stored flow, newest first. */
export async function candidateDates(
  sql: Sql,
  since: string,
): Promise<string[]> {
  const rows = (await sql`
    SELECT date::text AS date FROM (
      SELECT DISTINCT date FROM lottery_finder_fires
      WHERE date >= ${since}::date AND cum_ncp_at_fire IS NOT NULL
      UNION
      SELECT DISTINCT date FROM silent_boom_alerts
      WHERE date >= ${since}::date AND cum_ncp_at_fire IS NOT NULL
    ) d
    ORDER BY date DESC
  `) as Array<{ date: string }>;
  return rows.map((r) => r.date);
}

/** Rows in scope whose flow is NULL: not this script's, the backfill's. */
export async function countNullFlow(
  sql: Sql,
  since: string,
): Promise<Record<FireTable, number>> {
  const rows = (await sql`
    SELECT
      (SELECT COUNT(*) FROM lottery_finder_fires
        WHERE date >= ${since}::date AND cum_ncp_at_fire IS NULL)::int AS lottery,
      (SELECT COUNT(*) FROM silent_boom_alerts
        WHERE date >= ${since}::date AND cum_ncp_at_fire IS NULL)::int AS silentboom
  `) as Array<{ lottery: number; silentboom: number }>;
  const row = rows[0];
  if (row == null) throw new Error('null-flow count returned no row');
  return { lottery: row.lottery, silentboom: row.silentboom };
}

const toMs = (v: Date | string): number =>
  v instanceof Date ? v.getTime() : new Date(v).getTime();

/** One day's fires with stored flow, both tables. `id` is text, NUMERICs exact text or float8. */
export async function loadDay(sql: Sql, date: string): Promise<FireRow[]> {
  const lottery = (await sql`
    SELECT
      id::text AS id,
      underlying_symbol AS ticker,
      trigger_time_ct AS fire_at,
      cum_ncp_at_fire::text AS ncp,
      cum_npp_at_fire::text AS npp,
      option_type,
      tod,
      dte::int AS dte,
      trigger_vol_to_oi_window::float8 AS vol_oi,
      gamma_at_trigger::float8 AS gamma,
      trigger_ask_pct::float8 AS ask_pct,
      score::int AS score,
      score_version
    FROM lottery_finder_fires
    WHERE date = ${date}::date
      AND cum_ncp_at_fire IS NOT NULL AND cum_npp_at_fire IS NOT NULL
    ORDER BY id
  `) as Array<{
    id: string;
    ticker: string;
    fire_at: Date | string;
    ncp: string;
    npp: string;
    option_type: 'C' | 'P';
    tod: string;
    dte: number;
    vol_oi: number | null;
    gamma: number | null;
    ask_pct: number | null;
    score: number | null;
    score_version: DbText;
  }>;
  const silent = (await sql`
    SELECT
      id::text AS id,
      underlying_symbol AS ticker,
      bucket_ct AS fire_at,
      cum_ncp_at_fire::text AS ncp,
      cum_npp_at_fire::text AS npp
    FROM silent_boom_alerts
    WHERE date = ${date}::date
      AND cum_ncp_at_fire IS NOT NULL AND cum_npp_at_fire IS NOT NULL
    ORDER BY id
  `) as Array<{
    id: string;
    ticker: string;
    fire_at: Date | string;
    ncp: string;
    npp: string;
  }>;
  return [
    ...lottery.map(
      (r): FireRow => ({
        table: 'lottery',
        id: r.id,
        date,
        ticker: r.ticker,
        atMs: toMs(r.fire_at),
        ncp: r.ncp,
        npp: r.npp,
        lottery: {
          optionType: r.option_type,
          tod: r.tod,
          dte: r.dte,
          volOi: r.vol_oi,
          gamma: r.gamma,
          askPct: r.ask_pct,
          score: r.score,
          scoreVersion: r.score_version,
        },
      }),
    ),
    ...silent.map(
      (r): FireRow => ({
        table: 'silentboom',
        id: r.id,
        date,
        ticker: r.ticker,
        atMs: toMs(r.fire_at),
        ncp: r.ncp,
        npp: r.npp,
        lottery: null,
      }),
    ),
  ];
}

export interface GroupReading {
  hasWs: boolean;
  /** One entry per requested fire time, in order. */
  atFire: LegacyAtFire[];
}

interface LegacyRow {
  i: number;
  has_ws: boolean;
  ws_ncp: DbText;
  ws_npp: DbText;
  h_ncp: DbText;
  h_npp: DbText;
  l_ncp: DbText;
  l_npp: DbText;
}

function flowOf(ncp: DbText, npp: DbText): Flow | null {
  return ncp == null || npp == null
    ? null
    : { ncp: Number(ncp), npp: Number(npp) };
}

/**
 * The legacy readings at each fire time of one ticker-day, aggregated in the
 * database: the WS-only, history-only (minute-start stamps) and legacy-union
 * cumulative flow at each fire. One round trip; the result is one row per fire.
 */
export async function readLegacyAtFires(
  sql: Sql,
  ticker: string,
  date: string,
  fireMs: readonly number[],
): Promise<GroupReading> {
  const session = ctSessionBounds(date);
  const fires = fireMs.map((ms) => new Date(ms).toISOString());
  const rows = (await sql`
    WITH fires AS (
      SELECT t.fire_at, t.i
      FROM unnest(${fires}::timestamptz[]) WITH ORDINALITY AS t(fire_at, i)
    ),
    ws AS MATERIALIZED (
      SELECT ts, net_call_prem AS ncp, net_put_prem AS npp
      FROM ws_net_flow_per_ticker
      WHERE ticker = ${ticker}
        AND ts >= ${session.min}::timestamptz
        AND ts <= ${session.max}::timestamptz
    ),
    hist AS MATERIALIZED (
      SELECT DISTINCT ON (ts) ts, net_call_prem AS ncp, net_put_prem AS npp
      FROM net_flow_per_ticker_history
      WHERE ticker = ${ticker}
        AND ts >= ${session.min}::timestamptz
        AND ts <= ${session.max}::timestamptz
      ORDER BY ts, source
    ),
    legacy AS MATERIALIZED (
      SELECT DISTINCT ON (ts) ts, ncp, npp
      FROM (
        SELECT ts, ncp, npp, 1 AS priority FROM ws
        UNION ALL
        SELECT ts, ncp, npp, 2 AS priority FROM hist
      ) combined
      ORDER BY ts, priority
    )
    SELECT
      f.i::int AS i,
      EXISTS (SELECT 1 FROM ws) AS has_ws,
      (SELECT SUM(ncp) FROM ws WHERE ts <= f.fire_at)::text AS ws_ncp,
      (SELECT SUM(npp) FROM ws WHERE ts <= f.fire_at)::text AS ws_npp,
      (SELECT SUM(ncp) FROM hist WHERE ts <= f.fire_at)::text AS h_ncp,
      (SELECT SUM(npp) FROM hist WHERE ts <= f.fire_at)::text AS h_npp,
      (SELECT SUM(ncp) FROM legacy WHERE ts <= f.fire_at)::text AS l_ncp,
      (SELECT SUM(npp) FROM legacy WHERE ts <= f.fire_at)::text AS l_npp
    FROM fires f
    ORDER BY f.i
  `) as LegacyRow[];
  if (rows.length !== fireMs.length) {
    throw new Error(
      `${ticker} ${date}: asked for ${fireMs.length} fire readings, got ${rows.length}`,
    );
  }
  return {
    hasWs: rows[0]?.has_ws ?? false,
    atFire: rows.map((r) => ({
      ws: flowOf(r.ws_ncp, r.ws_npp),
      history: flowOf(r.h_ncp, r.h_npp),
      union: flowOf(r.l_ncp, r.l_npp),
    })),
  };
}

interface GapRowDb {
  ts: Date | string;
  gap_ncp: DbText;
  gap_npp: DbText;
}

/**
 * The history minutes of one ticker-day that carry flow and have no WS tick in
 * [ts, ts + 60 s): the minutes a WS-only series misses. One round trip per
 * ticker-day, and the result is the gap minutes only (at most one per session
 * minute), which `gapAtFire` then cuts per fire in memory. The history side is
 * the same one-row-per-minute read the series uses. The NOT EXISTS probe of
 * `ws_net_flow_per_ticker` carries the series' own session bounds on `ts` as
 * well as the minute's window, so it reads only what the series reads (a tick
 * past the session close hides no gap) and the planner has a bounded
 * (ticker, ts) range on the unique index `ws_net_flow_per_ticker_uq` to work
 * with.
 */
export async function readWsGaps(
  sql: Sql,
  ticker: string,
  date: string,
): Promise<GapMinute[]> {
  const session = ctSessionBounds(date);
  const rows = (await sql`
    SELECT h.ts, h.ncp::text AS gap_ncp, h.npp::text AS gap_npp
    FROM (
      SELECT DISTINCT ON (ts) ts, net_call_prem AS ncp, net_put_prem AS npp
      FROM net_flow_per_ticker_history
      WHERE ticker = ${ticker}
        AND ts >= ${session.min}::timestamptz
        AND ts <= ${session.max}::timestamptz
      ORDER BY ts, source
    ) h
    WHERE (COALESCE(h.ncp, 0) <> 0 OR COALESCE(h.npp, 0) <> 0)
      AND NOT EXISTS (
        SELECT 1
        FROM ws_net_flow_per_ticker w
        WHERE w.ticker = ${ticker}
          AND w.ts >= ${session.min}::timestamptz
          AND w.ts <= ${session.max}::timestamptz
          AND w.ts >= h.ts
          AND w.ts < h.ts + INTERVAL '60 seconds'
      )
    ORDER BY h.ts
  `) as GapRowDb[];
  return rows.map((r) => ({
    ts: toMs(r.ts),
    ncp: Number(r.gap_ncp ?? 0),
    npp: Number(r.gap_npp ?? 0),
  }));
}

/**
 * Judge one ticker-day's fires. A ticker-day with a doubled or a look-ahead row
 * gets one more read, its WS gaps (one per ticker-day, whatever the rows).
 */
async function judgeGroup(
  sql: Sql,
  ticker: string,
  date: string,
  rows: readonly FireRow[],
): Promise<Judged[]> {
  const series = await fetchTickerFlowSeries(sql, ticker, date);
  const reading = await readLegacyAtFires(
    sql,
    ticker,
    date,
    rows.map((r) => r.atMs),
  );
  const judged = rows.map((row, i) => {
    const at = flowAtFireTime(series, new Date(row.atMs));
    const fixed =
      at.cumNcp == null || at.cumNpp == null
        ? null
        : { ncp: at.cumNcp, npp: at.cumNpp };
    const stored = { ncp: Number(row.ncp), npp: Number(row.npp) };
    const legacy = reading.atFire[i];
    if (legacy == null)
      throw new Error(`${ticker} ${date}: reading ${i} missing`);
    return {
      row,
      stored,
      verdict: classifyRow({ stored, fixed, hasWs: reading.hasWs, legacy }),
      gap: null as GapReading | null,
    };
  });
  const readsGap = (j: { verdict: Verdict }): boolean =>
    j.verdict.kind === 'doubled' || j.verdict.kind === 'lookahead';
  if (!judged.some(readsGap)) return judged;
  const gapMinutes = await readWsGaps(sql, ticker, date);
  return judged.map((j) =>
    readsGap(j) ? { ...j, gap: gapAtFire(gapMinutes, j.row.atMs) } : j,
  );
}

/**
 * Read every date in scope and judge every fire. Nothing is written. Dates are
 * walked one at a time (a day's fires are bounded); within a day the
 * ticker-days are read three at a time.
 */
export async function planCorrection(
  sql: Sql,
  opts: { since: string; listLimit: number },
  weights: LotteryWeights,
  activeVersion: string,
): Promise<Plan> {
  const plan = emptyPlan();
  const ctx: PlanContext = {
    weights,
    activeVersion,
    listLimit: opts.listLimit,
  };
  for (const date of await candidateDates(sql, opts.since)) {
    const byTicker = new Map<string, FireRow[]>();
    for (const row of await loadDay(sql, date)) {
      const list = byTicker.get(row.ticker);
      if (list) list.push(row);
      else byTicker.set(row.ticker, [row]);
    }
    const groups = [...byTicker.entries()];
    const judged = await mapWithConcurrency(
      groups,
      GROUP_CONCURRENCY,
      ([ticker, rows]) => judgeGroup(sql, ticker, date, rows),
    );
    for (const group of judged) {
      for (const one of group) recordRow(plan, one, ctx);
    }
  }
  return plan;
}

// ── Writes and undo ─────────────────────────────────────────────────────────

/**
 * What an undo file holds per row: the table, the id, the values before and
 * after. A look-ahead row's `new` flow is null, and its undo moves from NULL.
 */
const UndoRowSchema = z.object({
  table: z.enum(['lottery', 'silentboom']),
  id: z.string().regex(/^\d+$/),
  old: z.object({
    ncp: z.string().nullable(),
    npp: z.string().nullable(),
    score: z.number().int().nullable(),
    version: z.string().nullable(),
  }),
  new: z.object({
    ncp: z.string().nullable(),
    npp: z.string().nullable(),
    score: z.number().int().nullable(),
    version: z.string().nullable(),
  }),
});
const UndoFileSchema = z.object({
  note: z.string(),
  since: z.string(),
  rows: z.array(UndoRowSchema),
});
type UndoRow = z.infer<typeof UndoRowSchema>;

export const UNDO_NOTE =
  'Every row below was changed from `old` to `new` by correct-doubled-fire-flow.ts. Undo: `npx tsx scripts/correct-doubled-fire-flow.ts --undo-file <this file> --apply`, which restores `old` on a row only while it still holds `new`.';

function toUndoRow(change: Change): UndoRow {
  return {
    table: change.table,
    id: change.id,
    old: change.old,
    new: change.new,
  };
}

/**
 * The undo file, written before the first UPDATE. Returns its path. `wx`: a
 * file already there is never overwritten (it is the only record of an earlier
 * run), and `flush` puts it on disk before the first UPDATE can need it.
 */
export function writeUndoFile(
  dir: string,
  since: string,
  changes: readonly Change[],
  now: Date,
): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `undo-${now.toISOString().replaceAll(':', '-')}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      note: UNDO_NOTE,
      since,
      rows: changes.map(toUndoRow),
    }),
    { flag: 'wx', flush: true },
  );
  return file;
}

/**
 * Move rows from `from` to `to`, 500 to a statement, each guarded on the row
 * still holding `from` in every column. A NULL flow is a value: the guard is
 * IS NOT DISTINCT FROM, so a look-ahead row moves from its number to NULL on
 * apply and from NULL back to its number on undo (`=` would match neither).
 * The apply direction also requires the `active` pointer to name `to.version`
 * when a row's tag changes. Returns the number of rows actually written.
 */
export async function moveRows(
  sql: Sql,
  table: FireTable,
  rows: readonly UndoRow[],
  direction: 'apply' | 'undo',
): Promise<number> {
  let written = 0;
  const forward = direction === 'apply';
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const chunk = rows.slice(i, i + WRITE_CHUNK);
    const pick = (row: UndoRow) => (forward ? row.old : row.new);
    const put = (row: UndoRow) => (forward ? row.new : row.old);
    const ids = chunk.map((r) => r.id);
    const fromNcp = chunk.map((r) => pick(r).ncp);
    const fromNpp = chunk.map((r) => pick(r).npp);
    const fromScore = chunk.map((r) => pick(r).score);
    const fromVersion = chunk.map((r) => pick(r).version);
    const toNcp = chunk.map((r) => put(r).ncp);
    const toNpp = chunk.map((r) => put(r).npp);
    const toScore = chunk.map((r) => put(r).score);
    const toVersion = chunk.map((r) => put(r).version);
    const done = (
      table === 'lottery'
        ? await sql`
            UPDATE lottery_finder_fires AS f
            SET cum_ncp_at_fire = u.to_ncp,
                cum_npp_at_fire = u.to_npp,
                score = u.to_score,
                score_version = u.to_version
            FROM unnest(
              ${ids}::bigint[],
              ${fromNcp}::numeric[], ${fromNpp}::numeric[],
              ${fromScore}::int[], ${fromVersion}::text[],
              ${toNcp}::numeric[], ${toNpp}::numeric[],
              ${toScore}::int[], ${toVersion}::text[]
            ) AS u(id, from_ncp, from_npp, from_score, from_version,
                   to_ncp, to_npp, to_score, to_version)
            WHERE f.id = u.id
              AND f.cum_ncp_at_fire IS NOT DISTINCT FROM u.from_ncp
              AND f.cum_npp_at_fire IS NOT DISTINCT FROM u.from_npp
              AND f.score IS NOT DISTINCT FROM u.from_score
              AND f.score_version IS NOT DISTINCT FROM u.from_version
              AND (
                NOT ${forward}::boolean
                OR u.to_version IS NOT DISTINCT FROM u.from_version
                OR EXISTS (
                  SELECT 1 FROM lottery_score_pointers p
                  WHERE p.name = 'active' AND p.version = u.to_version
                )
              )
            RETURNING f.id`
        : await sql`
            UPDATE silent_boom_alerts AS f
            SET cum_ncp_at_fire = u.to_ncp, cum_npp_at_fire = u.to_npp
            FROM unnest(
              ${ids}::bigint[],
              ${fromNcp}::numeric[], ${fromNpp}::numeric[],
              ${toNcp}::numeric[], ${toNpp}::numeric[]
            ) AS u(id, from_ncp, from_npp, to_ncp, to_npp)
            WHERE f.id = u.id
              AND f.cum_ncp_at_fire IS NOT DISTINCT FROM u.from_ncp
              AND f.cum_npp_at_fire IS NOT DISTINCT FROM u.from_npp
            RETURNING f.id`
    ) as Array<{ id: unknown }>;
    written += done.length;
  }
  return written;
}

async function activeVersionNow(sql: Sql): Promise<string | null> {
  const rows = (await sql`
    SELECT version FROM lottery_score_pointers WHERE name = 'active'
  `) as Array<{ version: string }>;
  return rows[0]?.version ?? null;
}

// ── Run and report ──────────────────────────────────────────────────────────

const n = (value: number): string => value.toLocaleString('en-US');

export interface CorrectionResult {
  apply: boolean;
  since: string;
  /** The active version a re-scored or NULLed row is tagged with. */
  version: string;
  nullFlow: Record<FireTable, number>;
  plan: Omit<Plan, 'changes'> & {
    toWrite: Record<FireTable, number>;
    score: Map<Change['score'], number>;
    toUnaligned: string[];
    toAligned: string[];
    /** The first `listLimit` planned writes, by date, table and id. */
    listedChanges: Change[];
    gaps: GapSummary;
  };
  written: Record<FireTable, number>;
  undoFile: string | null;
  /**
   * An apply during which the `active` pointer moved off `version`, yet every
   * planned row was written (`to`: the version it names now, null for none).
   * A move that left rows unwritten is an error instead. null: it did not move.
   */
  pointerMoved: { to: string | null } | null;
}

export async function runCorrection(opts: {
  apply: boolean;
  since: string;
  undoDir: string;
  listLimit: number;
}): Promise<CorrectionResult> {
  const sql = getDb();
  const active = await loadActive();
  const nullFlow = await countNullFlow(sql, opts.since);
  const plan = await planCorrection(
    sql,
    { since: opts.since, listLimit: opts.listLimit },
    active.weights,
    active.version,
  );
  const { changes, ...rest } = plan;
  const toWrite: Record<FireTable, number> = { lottery: 0, silentboom: 0 };
  const score = new Map<Change['score'], number>();
  const toUnaligned: string[] = [];
  const toAligned: string[] = [];
  for (const change of changes) {
    toWrite[change.table] += 1;
    if (change.table === 'lottery') {
      score.set(change.score, (score.get(change.score) ?? 0) + 1);
      if (change.flipped === 'to-unaligned') toUnaligned.push(change.id);
      if (change.flipped === 'to-aligned') toAligned.push(change.id);
    }
  }
  const ordered = orderPlanned(changes);
  const summary = {
    ...rest,
    toWrite,
    score,
    toUnaligned,
    toAligned,
    listedChanges: ordered.slice(0, opts.listLimit),
    gaps: summarizeGaps(ordered, opts.listLimit),
  };
  const written: Record<FireTable, number> = { lottery: 0, silentboom: 0 };
  if (!opts.apply || changes.length === 0) {
    return {
      apply: opts.apply,
      since: opts.since,
      version: active.version,
      nullFlow,
      plan: summary,
      written,
      undoFile: null,
      pointerMoved: null,
    };
  }
  const undoFile = writeUndoFile(opts.undoDir, opts.since, changes, new Date());
  try {
    for (const table of ['lottery', 'silentboom'] as const) {
      written[table] = await moveRows(
        sql,
        table,
        changes.filter((c) => c.table === table).map(toUndoRow),
        'apply',
      );
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${reason}. The apply did not complete. The undo file ${undoFile} was written before it; every statement is all-or-nothing and the run is safe to repeat: a dry run shows what is left.`,
      { cause: err },
    );
  }
  // A statement that sets a new tag writes only while the pointer names it, so
  // a promotion in the middle of the run stops those writes. When rows were
  // left unwritten, say so, with what was written, rather than end with a count
  // that looks like another writer's. When every planned row was written the
  // move cost nothing: the run is a success (exit 0) with a note in the report.
  const nowActive = await activeVersionNow(sql);
  const pointerMoved = nowActive === active.version ? null : { to: nowActive };
  const wrote = written.lottery + written.silentboom;
  const planned = toWrite.lottery + toWrite.silentboom;
  if (pointerMoved != null && wrote < planned) {
    throw new Error(
      `the active pointer moved from ${active.version} to ${pointerMoved.to ?? 'nothing'} during the run. ${n(wrote)} of ${n(planned)} planned rows were written under ${active.version} before it moved (lottery ${n(written.lottery)} of ${n(toWrite.lottery)}, silent boom ${n(written.silentboom)} of ${n(toWrite.silentboom)}). The rest were not written: a row that sets a new score_version needs the pointer to name ${active.version}, and a row another writer changed is skipped. The undo file ${undoFile} lists every planned row. Run a dry run to see what is left; it scores with the new active version.`,
    );
  }
  return {
    apply: true,
    since: opts.since,
    version: active.version,
    nullFlow,
    plan: summary,
    written,
    undoFile,
    pointerMoved,
  };
}

export interface UndoResult {
  apply: boolean;
  file: string;
  rows: Record<FireTable, number>;
  restored: Record<FireTable, number>;
}

/** Restore the old values from an undo file, only where a row still holds the new ones. */
export async function runUndo(opts: {
  file: string;
  apply: boolean;
}): Promise<UndoResult> {
  const text = readFileSync(opts.file, 'utf8');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (err) {
    throw new Error(`${opts.file} is not valid JSON`, { cause: err });
  }
  const parsed = UndoFileSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `${opts.file} is not an undo file from this script: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim(),
    );
  }
  const byTable: Record<FireTable, UndoRow[]> = { lottery: [], silentboom: [] };
  for (const row of parsed.data.rows) byTable[row.table].push(row);
  const rows = {
    lottery: byTable.lottery.length,
    silentboom: byTable.silentboom.length,
  };
  const restored: Record<FireTable, number> = { lottery: 0, silentboom: 0 };
  if (opts.apply) {
    const sql = getDb();
    for (const table of ['lottery', 'silentboom'] as const) {
      restored[table] = await moveRows(sql, table, byTable[table], 'undo');
    }
  }
  return { apply: opts.apply, file: opts.file, rows, restored };
}

export function formatUndoReport(result: UndoResult): string {
  const lines = [
    result.apply
      ? 'UNDO: old values were restored where a row still held the values the correction wrote.'
      : 'DRY RUN: nothing was written. Re-run with --apply to restore.',
    `File: ${result.file}`,
    `Rows in the file: lottery ${n(result.rows.lottery)}, silent boom ${n(result.rows.silentboom)}`,
  ];
  if (result.apply) {
    lines.push(
      `Rows restored:    lottery ${n(result.restored.lottery)}, silent boom ${n(result.restored.silentboom)}`,
    );
    const skipped =
      result.rows.lottery -
      result.restored.lottery +
      (result.rows.silentboom - result.restored.silentboom);
    if (skipped > 0) {
      lines.push(
        `WARNING: ${n(skipped)} rows no longer held the corrected values (another writer changed them since); they keep their value.`,
      );
    }
  }
  return lines.join('\n');
}

function headline(result: CorrectionResult): string {
  if (!result.apply) {
    return 'DRY RUN: nothing was written. Re-run with --apply to write.';
  }
  const total = result.written.lottery + result.written.silentboom;
  return total > 0
    ? 'APPLY: corrected values were written.'
    : 'APPLY: nothing was written.';
}

const REASON_TEXT: Record<OtherReason, string> = {
  'no-fixed-value':
    'the fixed series has no value at the fire, and the stored value is not the history sum up to the fire',
  'history-only-day':
    'history-only day: not doubled, holds up to 59 s of look-ahead',
  unmatched: 'matches neither the fixed value nor a doubled value',
};

const SCORE_TEXT: Record<Change['score'], string> = {
  none: 'no score (silent boom)',
  unchanged: 'alignment unchanged: score and tag left',
  nulled:
    'now against the flow: score set to NULL and tagged with the active version',
  'nulled-pre-seed': `fire before ${SEED_WEIGHTS_LIVE_FROM}, now against the flow: score set to NULL, tag left`,
  set: 'now with the flow: score computed with the active weights',
  'left-pre-seed': `fire before ${SEED_WEIGHTS_LIVE_FROM}, now with the flow: flow corrected, score left`,
  'left-unscorable': 'unknown tod: flow corrected, score left',
};

const CATEGORY_TEXT: Record<ChangeCategory, string> = {
  doubled: 'doubled',
  lookahead: 'look-ahead',
};

/** Right-aligned numeric columns, `CELL` wide. */
const CELL = 11;
const cells = (values: ReadonlyArray<number | string>): string =>
  values.map((v) => (typeof v === 'number' ? n(v) : v).padStart(CELL)).join('');
/** Where the first column of the per-table and per-date blocks starts. */
const LABEL = 26;

const scoreAndTag = (s: Stored): string =>
  `${s.score ?? 'NULL'} (${s.version ?? 'NULL'})`;

/** One planned write: the fire, its category, and what each stored column goes from and to. */
function describeChange(c: Change): string {
  const flow = `flow ${c.old.ncp ?? 'NULL'} / ${c.old.npp ?? 'NULL'} -> ${c.new.ncp ?? 'NULL'} / ${c.new.npp ?? 'NULL'}`;
  const score =
    c.table === 'lottery'
      ? `; score ${scoreAndTag(c.old)} -> ${scoreAndTag(c.new)}`
      : '';
  return `  ${c.table} ${c.id} ${c.date} ${c.ticker} ${c.fireAt.slice(11)} ${CATEGORY_TEXT[c.category]}: ${flow}${score}`;
}

function describeGapRow(row: GapRow): string {
  const flips = row.flips == null ? 'n/a' : row.flips ? 'yes' : 'no';
  return `    ${row.table} ${row.id} ${row.date} ${row.ticker}: ${n(row.minutes)} gap minute${row.minutes === 1 ? '' : 's'}, gap flow ${n(row.gapNcp)} / ${n(row.gapNpp)}, corrected ${n(row.ncp)} / ${n(row.npp)}, flips ${flips}`;
}

function describeLookaheadGapRow(row: LookaheadGapRow): string {
  return `    ${row.table} ${row.id} ${row.date} ${row.ticker} ${row.fireAt.slice(11)}: ${n(row.minutes)} gap minute${row.minutes === 1 ? '' : 's'}, gap flow ${n(row.gapNcp)} / ${n(row.gapNpp)}`;
}

/**
 * The look-ahead gap block: how many look-ahead rows were read, how many hold a
 * complete nonzero history minute before the fire (an explicit count, 0
 * included), and those rows up to the list limit.
 */
function lookaheadGapLines(gaps: GapSummary): string[] {
  const { read, withMinutes, rows } = gaps.lookahead;
  if (read.lottery + read.silentboom === 0) return [];
  const held = withMinutes.lottery + withMinutes.silentboom;
  const lines = [
    '',
    'WS gaps before a look-ahead fire (the row is written NULL, as live stored it; the first WS tick comes after the fire, so a complete history minute before it is flow the NULL leaves out):',
    `  Look-ahead rows read: lottery ${n(read.lottery)}, silent boom ${n(read.silentboom)}`,
    `  holding at least one complete nonzero history minute before the fire: lottery ${n(withMinutes.lottery)}, silent boom ${n(withMinutes.silentboom)}`,
  ];
  for (const row of rows) lines.push(describeLookaheadGapRow(row));
  if (held > rows.length) {
    lines.push(`  ... ${n(held - rows.length)} more not listed (--list-limit)`);
  }
  return lines;
}

/** The WS gap block of the doubled rows: counts, then the material rows up to the list limit. */
function doubledGapLines(gaps: GapSummary): string[] {
  const read = gaps.doubled.lottery + gaps.doubled.silentboom;
  if (read === 0) return [];
  const material = gaps.material.lottery + gaps.material.silentboom;
  const pct = Math.round(MATERIAL_GAP_FRACTION * 100);
  const lines = [
    '',
    'WS gaps (doubled rows only; the corrected value stays WS-only, as live stored it. Whether to fill gaps from history is an open owner decision):',
    `  Doubled rows read: lottery ${n(gaps.doubled.lottery)}, silent boom ${n(gaps.doubled.silentboom)}`,
    `  with at least one history minute that has no WS tick: lottery ${n(gaps.withGap.lottery)}, silent boom ${n(gaps.withGap.silentboom)}`,
    `  material (gap flow over ${pct}% of the corrected flow on either side): lottery ${n(gaps.material.lottery)}, silent boom ${n(gaps.material.silentboom)}`,
    `  material-gap lottery rows whose alignment the gap flow would flip: ${n(gaps.flips)}`,
  ];
  for (const row of gaps.rows) lines.push(describeGapRow(row));
  if (material > gaps.rows.length) {
    lines.push(
      `  ... ${n(material - gaps.rows.length)} more not listed (--list-limit)`,
    );
  }
  return lines;
}

export function formatReport(result: CorrectionResult): string {
  const { plan } = result;
  const toWrite = plan.toWrite.lottery + plan.toWrite.silentboom;
  const lines = [
    headline(result),
    `Scope: lottery_finder_fires and silent_boom_alerts, date >= ${result.since}, flow set. Active weights version: ${result.version}.`,
    '',
    `${'Per table:'.padEnd(LABEL)}${cells(['scanned', 'correct', 'doubled', 'look-ahead', 'other'])}`,
  ];
  for (const table of ['lottery', 'silentboom'] as const) {
    const c = plan.counts[table];
    lines.push(
      `  ${TABLE_NAME[table].padEnd(LABEL - 2)}${cells([plan.scanned[table], c.correct, c.doubled, c.lookahead, c.other])}`,
    );
  }
  lines.push(
    '',
    `Rows with NULL flow in scope (not touched: the backfill's job, and a fire before its ticker's first WS tick stays NULL by design): lottery ${n(result.nullFlow.lottery)}, silent boom ${n(result.nullFlow.silentboom)}`,
  );
  if (plan.byDate.size > 0) {
    lines.push(
      '',
      `${'Per fire date:'.padEnd(LABEL + CELL)}${cells(['correct', 'doubled', 'look-ahead', 'other'])}`,
    );
    for (const date of [...plan.byDate.keys()].sort()) {
      const c = plan.byDate.get(date) ?? emptyCounts();
      const label = `  ${date}`.padEnd(LABEL + CELL);
      lines.push(
        `${label}${cells([c.correct, c.doubled, c.lookahead, c.other])}`,
      );
    }
  }
  if (plan.score.size > 0) {
    lines.push(
      '',
      'Planned lottery rows (doubled and look-ahead), by what the score does:',
    );
    for (const [kind, count] of [...plan.score].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      lines.push(`  ${n(count).padStart(7)}  ${SCORE_TEXT[kind]}`);
    }
  }
  if (plan.toUnaligned.length + plan.toAligned.length > 0) {
    lines.push(
      '',
      `Alignment flips (Take-It inputs and cluster_bonus read the score, and are NOT changed here): ${n(plan.toUnaligned.length)} now against the flow, ${n(plan.toAligned.length)} now with it.`,
      `  now against the flow: ${plan.toUnaligned.join(', ') || 'none'}`,
      `  now with the flow:    ${plan.toAligned.join(', ') || 'none'}`,
    );
  }
  if (toWrite > 0) {
    lines.push(
      '',
      `Planned writes, fire time in UTC (${n(plan.listedChanges.length)} of ${n(toWrite)} listed):`,
      ...plan.listedChanges.map(describeChange),
    );
    if (toWrite > plan.listedChanges.length) {
      lines.push(
        `  ... ${n(toWrite - plan.listedChanges.length)} more not listed (--list-limit)`,
      );
    }
  }
  lines.push(...doubledGapLines(plan.gaps), ...lookaheadGapLines(plan.gaps));
  const otherTotal = plan.counts.lottery.other + plan.counts.silentboom.other;
  if (otherTotal > 0) {
    lines.push('', `Other mismatch (left alone): ${n(otherTotal)}`);
    for (const [reason, count] of [...plan.otherReasons].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      lines.push(`  ${n(count).padStart(7)}  ${REASON_TEXT[reason]}`);
    }
    for (const row of plan.otherRows) {
      lines.push(
        `  ${row.table} ${row.id} ${row.date} ${row.ticker}: stored ${row.stored.ncp} / ${row.stored.npp} (${row.reason})`,
      );
    }
    if (otherTotal > plan.otherRows.length) {
      lines.push(
        `  ... ${n(otherTotal - plan.otherRows.length)} more not listed (--list-limit)`,
      );
    }
  }
  lines.push(
    '',
    `To write: lottery ${n(plan.toWrite.lottery)}, silent boom ${n(plan.toWrite.silentboom)}`,
  );
  if (result.apply) {
    lines.push(
      `Rows written: lottery ${n(result.written.lottery)}, silent boom ${n(result.written.silentboom)}`,
    );
    const written = result.written.lottery + result.written.silentboom;
    if (written !== toWrite) {
      lines.push(
        `WARNING: ${n(toWrite - written)} planned rows were changed by another writer since the read; they kept their value.`,
      );
    }
    if (result.pointerMoved != null) {
      lines.push(
        `NOTE: the active pointer moved from ${result.version} to ${result.pointerMoved.to ?? 'nothing'} during the run, after the plan was read. All ${n(toWrite)} planned rows were written anyway; the rows that took a new score_version carry ${result.version}, which the pointer no longer names.`,
      );
    }
    if (result.undoFile != null) lines.push(`Undo file: ${result.undoFile}`);
  }
  if (toWrite === 0) lines.push('', 'Nothing to correct.');
  return lines.join('\n');
}
