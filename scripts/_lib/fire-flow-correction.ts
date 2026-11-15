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
 * the fixed value), and `other` for everything else. Only `doubled` rows are
 * written, with the fixed value. "Equal" is within FLOW_TOLERANCE_USD, half a
 * cent.
 *
 * Scores (lottery only). The V2 score depends on flow only through alignment
 * (`isAlignedFire`). For a corrected row whose alignment did not change, the
 * score and its tag are left alone. Aligned before and not after: the score
 * becomes NULL, as live scoring gives, and `score_version` is left as it was.
 * Not aligned before and aligned after: the score is computed with the weights
 * of the version the `active` pointer names (`loadActive`, `rescoreRow`: the
 * rescore's own helpers) and written with `score_version` = that version. A
 * fire before SEED_WEIGHTS_LIVE_FROM is never re-scored (an earlier fire was
 * scored with older weights); its flow is corrected, its score left, and it is
 * counted. `silent_boom_alerts` carries no flow-derived score.
 *
 * Writes. With `--apply` the plan is read in full first, an undo file is
 * written before the first UPDATE, and the writes are batches of 500 through
 * `unnest`, each guarded on the values the plan was read on (both flow columns,
 * the score and its tag), so a row any other writer changed in between is
 * skipped and a rerun finds nothing left. A write that sets a new
 * `score_version` also requires the `active` pointer to still name it.
 * `--undo-file` restores the old values, guarded on the row still holding the
 * values this run wrote.
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
/** Rows listed under "other mismatch" unless `--list-limit` says otherwise. */
export const DEFAULT_LIST_LIMIT = 200;
export const UNDO_DIR = 'docs/tmp/fire-flow-correction';

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
touched. For lottery fires whose alignment (call or put against the flow)
flips, the V2 score follows: NULL if the fire is now against the flow, a
score from the active weights if it is now with it. Reports, per table and per
date, the rows doubled, already correct, and other (left alone, listed).

Options:
  --since <date>      first fire date to cover, YYYY-MM-DD (required; not before
                      ${WS_FIRST_DAY}, the first day the WS table has rows)
  --apply             write (without it: dry run, which writes nothing). An undo
                      file is written under ${UNDO_DIR}/ first
  --dry-run           the default, said aloud; contradicts --apply
  --undo-file <file>  restore the values an earlier --apply wrote (with --apply;
                      without it, only counts the file's rows)
  --list-limit <n>    rows to list under "other mismatch" (default ${DEFAULT_LIST_LIMIT}; 0 lists none)
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
  /** The fixed series has no value at the fire (empty, or before its first row). */
  | 'no-fixed-value'
  /** A ticker-day with no WS rows: not doubled, but holds up to 59 s of look-ahead. */
  | 'history-only-day'
  /** Matches neither the fixed value nor a doubled candidate. */
  | 'unmatched';

export type Verdict =
  | { kind: 'correct' }
  | { kind: 'doubled'; fixed: Flow }
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
    return { kind: 'other', reason: 'no-fixed-value', fixed: null };
  }
  if (
    hasWs &&
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
  /** Aligned before, against the flow now: NULL, tag left. */
  | { kind: 'nulled' }
  /** With the flow now: the active version's score. */
  | { kind: 'set'; score: number }
  /** A fire from before SEED_WEIGHTS_LIVE_FROM whose alignment flipped: left. */
  | { kind: 'left-pre-seed' }
  /** With the flow now, but the weights have no table for its `tod`. */
  | { kind: 'left-unscorable' };

/** Whether a call or put fire is with the flow before the correction and after it. */
export function alignmentFlip(
  optionType: 'C' | 'P',
  stored: Flow,
  fixed: Flow,
): 'to-unaligned' | 'to-aligned' | null {
  const was = isAlignedFire(optionType, stored.ncp, stored.npp);
  const now = isAlignedFire(optionType, fixed.ncp, fixed.npp);
  if (was === now) return null;
  return now ? 'to-aligned' : 'to-unaligned';
}

/**
 * What the score does when the row's flow goes from the stored value (the
 * `cum_*` of `input.row`) to the fixed one.
 */
export function planScore(
  weights: LotteryWeights,
  input: LotteryScoreInputs,
  fixed: Flow,
): ScorePlan {
  const { row, score } = input;
  const flip = alignmentFlip(
    row.option_type,
    { ncp: row.cum_ncp_at_fire, npp: row.cum_npp_at_fire },
    fixed,
  );
  if (flip == null) return { kind: 'unchanged' };
  if (row.date < SEED_WEIGHTS_LIVE_FROM) return { kind: 'left-pre-seed' };
  if (flip === 'to-unaligned') {
    return score == null ? { kind: 'unchanged' } : { kind: 'nulled' };
  }
  const rescored = rescoreRow(weights, {
    ...row,
    cum_ncp_at_fire: fixed.ncp,
    cum_npp_at_fire: fixed.npp,
  });
  if (rescored === 'unscorable') return { kind: 'left-unscorable' };
  if (rescored == null || rescored === score) return { kind: 'unchanged' };
  return { kind: 'set', score: rescored };
}

// ── The plan ────────────────────────────────────────────────────────────────

/** The four stored values a write replaces, as exact text (null is NULL). */
export interface Stored {
  ncp: string;
  npp: string;
  score: number | null;
  version: string | null;
}

export interface Change {
  table: FireTable;
  id: string;
  date: string;
  ticker: string;
  old: Stored;
  new: Stored;
  /** Alignment flipped on the correction. */
  flipped: 'to-unaligned' | 'to-aligned' | null;
  score: ScorePlan['kind'] | 'none';
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
  /** Planned writes: the doubled rows. */
  changes: Change[];
}

function emptyCounts(): Counts {
  return { correct: 0, doubled: 0, other: 0 };
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

/** Fold one judged row into the plan. */
export function recordRow(
  plan: Plan,
  row: FireRow,
  verdict: Verdict,
  stored: Flow,
  weights: LotteryWeights,
  activeVersion: string,
  listLimit: number,
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
    if (plan.otherRows.length < listLimit) {
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
  if (verdict.kind !== 'doubled') return;

  const old: Stored = {
    ncp: row.ncp,
    npp: row.npp,
    score: row.lottery?.score ?? null,
    version: row.lottery?.scoreVersion ?? null,
  };
  const next: Stored = {
    ...old,
    ncp: numToText(verdict.fixed.ncp),
    npp: numToText(verdict.fixed.npp),
  };
  let flipped: Change['flipped'] = null;
  let scoreKind: Change['score'] = 'none';
  if (row.lottery != null) {
    const plain = toCandidate(row);
    flipped = alignmentFlip(plain.option_type, stored, verdict.fixed);
    const scorePlan = planScore(
      weights,
      { row: plain, score: row.lottery.score },
      verdict.fixed,
    );
    scoreKind = scorePlan.kind;
    if (scorePlan.kind === 'nulled') next.score = null;
    if (scorePlan.kind === 'set') {
      next.score = scorePlan.score;
      next.version = activeVersion;
    }
  }
  plan.changes.push({
    table: row.table,
    id: row.id,
    date: row.date,
    ticker: row.ticker,
    old,
    new: next,
    flipped,
    score: scoreKind,
  });
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

/** Judge one ticker-day's fires. */
async function judgeGroup(
  sql: Sql,
  ticker: string,
  date: string,
  rows: readonly FireRow[],
): Promise<Array<{ row: FireRow; verdict: Verdict; stored: Flow }>> {
  const series = await fetchTickerFlowSeries(sql, ticker, date);
  const reading = await readLegacyAtFires(
    sql,
    ticker,
    date,
    rows.map((r) => r.atMs),
  );
  return rows.map((row, i) => {
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
    };
  });
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
      for (const { row, verdict, stored } of group) {
        recordRow(
          plan,
          row,
          verdict,
          stored,
          weights,
          activeVersion,
          opts.listLimit,
        );
      }
    }
  }
  return plan;
}

// ── Writes and undo ─────────────────────────────────────────────────────────

/** What an undo file holds per row: the table, the id, the values before and after. */
const UndoRowSchema = z.object({
  table: z.enum(['lottery', 'silentboom']),
  id: z.string().regex(/^\d+$/),
  old: z.object({
    ncp: z.string(),
    npp: z.string(),
    score: z.number().int().nullable(),
    version: z.string().nullable(),
  }),
  new: z.object({
    ncp: z.string(),
    npp: z.string(),
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

/** The undo file, written before the first UPDATE. Returns its path. */
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
  );
  return file;
}

/**
 * Move rows from `from` to `to`, 500 to a statement, each guarded on the row
 * still holding `from` in every column. `guardPointer` (the apply direction)
 * also requires the `active` pointer to name `to.version` when a row's tag
 * changes. Returns the number of rows actually written.
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
              AND f.cum_ncp_at_fire = u.from_ncp
              AND f.cum_npp_at_fire = u.from_npp
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
              AND f.cum_ncp_at_fire = u.from_ncp
              AND f.cum_npp_at_fire = u.from_npp
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
  /** The active version a re-scored row is tagged with. */
  version: string;
  nullFlow: Record<FireTable, number>;
  plan: Omit<Plan, 'changes'> & {
    toWrite: Record<FireTable, number>;
    score: Map<Change['score'], number>;
    toUnaligned: string[];
    toAligned: string[];
  };
  written: Record<FireTable, number>;
  undoFile: string | null;
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
  const summary = { ...rest, toWrite, score, toUnaligned, toAligned };
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
  // a promotion in the middle of the run stops those writes. Say so.
  const nowActive = await activeVersionNow(sql);
  if (nowActive !== active.version) {
    throw new Error(
      `the active pointer moved from ${active.version} to ${nowActive ?? 'nothing'} during the run. Rows whose score changed may not have been written. The undo file ${undoFile} lists every planned row. Run a dry run to see what is left.`,
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
  const parsed = UndoFileSchema.safeParse(
    JSON.parse(readFileSync(opts.file, 'utf8')) as unknown,
  );
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
  'no-fixed-value': 'the fixed series has no value at the fire',
  'history-only-day':
    'history-only day: not doubled, holds up to 59 s of look-ahead',
  unmatched: 'matches neither the fixed value nor a doubled value',
};

const SCORE_TEXT: Record<Change['score'], string> = {
  none: 'no score (silent boom)',
  unchanged: 'alignment unchanged: score and tag left',
  nulled: 'now against the flow: score set to NULL',
  set: 'now with the flow: score computed with the active weights',
  'left-pre-seed': `fire before ${SEED_WEIGHTS_LIVE_FROM}: flow corrected, score left`,
  'left-unscorable': 'unknown tod: flow corrected, score left',
};

export function formatReport(result: CorrectionResult): string {
  const { plan } = result;
  const lines = [
    headline(result),
    `Scope: lottery_finder_fires and silent_boom_alerts, date >= ${result.since}, flow set. Active weights version: ${result.version}.`,
    '',
    'Per table:                  scanned   correct   doubled     other',
  ];
  for (const table of ['lottery', 'silentboom'] as const) {
    const c = plan.counts[table];
    lines.push(
      `  ${TABLE_NAME[table].padEnd(24)}${n(plan.scanned[table]).padStart(9)}${n(c.correct).padStart(10)}${n(c.doubled).padStart(10)}${n(c.other).padStart(10)}`,
    );
  }
  lines.push(
    '',
    `Rows with NULL flow in scope (the backfill's job, not touched): lottery ${n(result.nullFlow.lottery)}, silent boom ${n(result.nullFlow.silentboom)}`,
  );
  if (plan.byDate.size > 0) {
    lines.push('', 'Per fire date:                correct   doubled     other');
    for (const date of [...plan.byDate.keys()].sort()) {
      const c = plan.byDate.get(date) ?? emptyCounts();
      lines.push(
        `  ${date}${n(c.correct).padStart(18)}${n(c.doubled).padStart(10)}${n(c.other).padStart(10)}`,
      );
    }
  }
  if (plan.score.size > 0) {
    lines.push('', 'Doubled lottery rows, by what the score does:');
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
  const toWrite = plan.toWrite.lottery + plan.toWrite.silentboom;
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
    if (result.undoFile != null) lines.push(`Undo file: ${result.undoFile}`);
  }
  if (toWrite === 0) lines.push('', 'Nothing to correct.');
  return lines.join('\n');
}
