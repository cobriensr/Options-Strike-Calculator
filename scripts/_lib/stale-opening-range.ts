/**
 * The repair of stored opening ranges that were stale when saved (spec:
 * docs/superpowers/specs/2026-11-22-stale-opening-range-design.md, phase 3).
 * Logic for scripts/repair-stale-opening-range.ts; it lives here so vitest
 * covers it (scripts/_lib/**).
 *
 * A live page loaded before the day's first SPX bar, or a tab left open
 * overnight, saved a previous session's opening range in `market_snapshots`
 * (`opening_range_high`, `opening_range_low`, and the `opening_range_pct_consumed`
 * and `opening_range_signal` computed from them). Every row of every date is
 * checked against its own date's candles, not against a list of known days.
 *
 * Which rows are what. The as-of range at a row's slot is the range of the bars
 * that have ended by the slot (`spxSlotStateAsOf`, the owner's as-of rule: NULL
 * at 8:30 CT, partial until 9:00 CT). A row is, in this order:
 * - ok: its range is the as-of range, within 0.05 (prices are stored to 2
 *   decimals).
 * - look-ahead: a replayed (`is_backtest`) row before 10:00 ET that holds the
 *   date's complete range. A replay from before the as-of fix read the whole
 *   day. Counted and listed, never written (snapshot-builder phase 6 owns it).
 *   If the complete range cannot be read (a bad price on a bar that has ended by
 *   9:00 CT), such a replayed row that is not the as-of range is `skip`
 *   `no-as-of-state`: it could be a look-ahead, so it is not judged.
 * - rebase: inside the band [as-of range, range with the bar running at the
 *   slot], and not the as-of range. A live save before 10:00 ET legitimately
 *   saw the running bar. Counted, never written (a methodology question).
 * - lag: a live row that holds a range between the as-of range a bar earlier,
 *   widened by the open of the bar that ended at the slot, and the as-of range:
 *   a page that answered a bar behind. Before 10:00 ET on any date, and at 9:00
 *   CT (where the range completes) from the live fix on (2026-11-23); at 9:00 CT
 *   before the fix, the same row is an incomplete-range. Counted and listed,
 *   never written.
 * Rebase, lag and incomplete-range all yield to evidence of a carried-over
 * range: a row that holds the previous trading date's own range (the range the
 * most of that date's rows from 10:00 ET on hold, at least two of them, with no
 * other range holding as many; matched within 0.05) is stale whatever window it
 * falls in by chance, and is repaired.
 * - incomplete-range: a live row from 10:00 ET on, saved before the live fix
 *   (2026-11-23), whose range is narrower than the complete one only by the last
 *   seconds of the 9:55 bar (it sits between the range through the 9:50 bar,
 *   widened by the 9:55 bar's open, and the complete range). The owner decided
 *   (2026-11-25) to repair these. Their own kind, counted and listed apart, and
 *   written like any repair.
 * - stale (a repair): anything else outside the band, and a carried-over range
 *   wherever it falls. A previous session's range always lands here.
 * At 8:30 CT, with no ended bar, the band's lower bound is the open.
 *
 * What a repair gets. All four columns are recomputed: high and low from the
 * as-of range (all four NULL at 8:30 CT), and `opening_range_pct_consumed` and
 * `opening_range_signal` from `openingRangeSignal` (src/utils), the same
 * function the live hook calls, with the row's stored `spx` and
 * `median_hl_pct`. A row whose `median_hl_pct` is NULL, or not above 0, or not a
 * number, is NOT graded and NOTHING is written to it, whatever its range: the
 * function would read a missing median as 1, which is a guessed value, so such a
 * row goes in its own list for the owner. A row whose spot is unusable is listed
 * the same way. Nothing is half-repaired.
 *
 * Dates before Schwab's 5-minute candles (before FIRST_CANDLE_DATE: the Feb
 * replay rows whose range came from a previous date) have no candles. They take
 * the date's own range from its other rows: the stored range most of the date's
 * rows at or after 10:00 ET hold, when at least two do and no other range ties.
 * A row at or after 10:00 ET is repaired to it only with positive evidence: its
 * stored range is the previous trading date's own range, within 0.05, which is
 * what a range carried over looks like. Any other row that differs is listed and
 * left alone, and so is every row before 10:00 ET that differs (its partial range
 * has no candles to come from). If Schwab's window does not reach an early-March
 * date, its history comes back empty and that date is skipped as `history-failed`,
 * named, with exit code 1; it is not repaired from its own range.
 *
 * `training_features`: when the row `build-features` picks for a date
 * (`pickFeatureSnapshot`) is repaired (a repair or an incomplete-range one), and
 * the date's features row holds that row's old signal and consumed value, those
 * two columns are copied from the repaired row. They are written in the same
 * transaction as the date's rows, and only if the pick row holds the new values,
 * the way the feature trust repair does it, not by a full rebuild, which would
 * move other columns. When the pick row needs no repair and the features row
 * differs from it, the date is listed as out of sync.
 *
 * Known limit, reported and never repaired. `median_hl_pct` is taken as stored,
 * and on a held-tab day it may itself rest on a stale yesterday. The dry run
 * lists, by date, the rows whose stored `prev_close` is not the previous
 * session's close that /api/history reports (further off than the G1b rule's
 * 3.00: the 5-minute close and the official close differ by up to about 2.55, a
 * previous close from the wrong week by tens to hundreds), and the dates whose
 * previous session /api/history did not report. Nothing is written to them: the
 * server row builder (snapshot-builder phases 4 and 6) rebuilds those columns.
 *
 * Candles. `/api/history?date=D` at APP_URL, with the owner cookie OWNER_SECRET
 * (the same fetch the price-context backfill uses): they are Schwab's $SPX
 * 5-minute bars, which is what the page computed its range from. It reads and
 * writes nothing in Redis, so a dry run writes nothing but its plan file. The
 * spec names scripts/_lib/schwab-local.mjs for them; it reads the production
 * Redis token record and may refresh it, which can race the crons, so this script
 * asks the app instead. The database's `spx_candles_1m` is SPY-translated and is
 * not them. The environment is DATABASE_URL, and APP_URL and OWNER_SECRET only
 * when a date from FIRST_CANDLE_DATE on is planned; none is printed as it is. The
 * origin goes to stderr. The tool prints or writes no name derived from
 * DATABASE_URL (`host/name`, see `databaseOf`) until a query on it has
 * succeeded. What it cannot promise: `getDb` replaces a driver error that echoes
 * the connection string (the one for a URL it will not parse) with a fixed
 * message, and refuses before the driver a URL holding a NUL, CR or LF, which a
 * request header cannot carry and whose error would hold the string. The
 * driver's other errors, and the database server's error text for a failed
 * first query, pass through as they are, and the latter may name the role or
 * the database ("password authentication failed for user ...").
 *
 * The run. A dry run is the default: it writes a plan file (what it would write,
 * with the scope and the database, `host/name`) under the backup directory and
 * nothing to the database. It refuses before `getDb()` when DATABASE_URL is
 * missing, does not parse, or parses with a host that is not what the string
 * says, without printing it. `--apply --plan F`
 * refuses first if F was written for another database, or if F's scope covers
 * more than one date and `--all` is not also given (the owner's rule: one date
 * first, then all; a `--date` plan, or a `--since` and `--until` naming one day,
 * applies without it). It then plans afresh and refuses if any row's new values,
 * or the stored values the repair replaces (its before values, and the features
 * row's), or the set of rows, differ from F (a row F lists that already holds
 * its new values is fine: a second apply writes nothing), writes the backup file
 * (with `wx`: an existing file is never overwritten, and the run stops before
 * any write), and then, one date at a time, the date's rows (500 to a statement,
 * R5) and its features row in one transaction, each row only where it still holds
 * the values the read found (R6). A row that changed since is listed and left
 * alone. A failure part-way rolls back the date it was in, leaves the dates
 * before it written, and says so: how many rows, which dates' features are not
 * copied, the backup and the undo command. `--undo-file F --apply` restores the
 * old values under the reverse guard, a features row only together with its pick
 * row, and refuses a backup written for another database.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';

import {
  pickFeatureSnapshot,
  SNAPSHOT_TRUST_COLUMNS_SQL,
  type SnapshotTrustColumns,
} from '../../api/cron/build-features.js';
import { getDb, withDbRetry } from '../../api/_lib/db.js';
import {
  isTradingDay,
  OPENING_RANGE_END_MIN_ET,
  priorTradingDay,
} from '../../src/data/marketHours.js';
import {
  ET_AHEAD_OF_CT_MIN,
  parseEntryTimeMinutes,
} from '../../src/utils/entry-time.js';
import { openingRangeSignal } from '../../src/utils/opening-range-signal.js';
import {
  spxSlotStateAsOf,
  type SlotCandle,
} from '../../src/utils/snapshot-slot.js';
import { getETToday, getETTotalMinutes } from '../../src/utils/timezone.js';
import { databaseOf, NO_DATABASE } from './db-host.js';
import {
  FETCH_PAUSE_MS,
  fetchHistory,
  historyAccess,
  historyOrigin,
  previousCloseOf,
  SETTLEMENT_TOLERANCE_CENTS,
  toDecimal2,
  WRITE_CHUNK,
} from './snapshot-price-context.js';

type Sql = ReturnType<typeof getDb>;

/** Where the plan and backup files go, relative to the working directory. */
export const BACKUP_DIR = 'docs/tmp/stale-opening-range';
/** A stored price may sit this far outside the band and still be live. */
export const STALE_TOLERANCE = 0.05;
const TOLERANCE_CENTS = Math.round(STALE_TOLERANCE * 100);
/**
 * Schwab's 5-minute bars reach back to about here (the trust spec: "on dates
 * before 03-05 the backfill had no candles"). Earlier dates take the date's
 * own range.
 */
export const FIRST_CANDLE_DATE = '2026-03-05';
/**
 * The first date the live page keeps its range current (phase 1 of the spec,
 * shipped for the open of Monday 2026-11-23). A live row saved before it at or
 * after 9:00 CT that is narrower than the complete range only by the 9:55 bar's
 * last seconds is an incomplete-range row, written like a repair. From this date
 * on such a row at 9:00 CT is a lag (a page that answered a bar behind: counted,
 * never written), and after 9:00 CT it is a stale repair.
 */
export const LIVE_FIX_DATE = '2026-11-23';
/** The history candle length, minutes. */
const BAR_MINUTES = 5;
/** 10:00 ET as a CT slot: from here the opening range is complete (540). */
const COMPLETE_FROM_CT = OPENING_RANGE_END_MIN_ET - ET_AHEAD_OF_CT_MIN;
/** DECIMAL(6,4) holds a consumed value below this. */
const CONSUMED_MAX = 99.9999;
/** A report line names at most this many row ids; the count says the rest. */
const LISTED_IDS = 12;
/** The largest value of the SERIAL id column. */
const MAX_ID = 2_147_483_647;

// ── Types ───────────────────────────────────────────────────────────────────

/** A market_snapshots row as the script reads it: DECIMAL columns as text. */
export interface RangeRow extends SnapshotTrustColumns {
  id: number;
  /** `YYYY-MM-DD` */
  date: string;
  entry_time: string;
  spx: string | null;
  spx_open: string | null;
  spx_high: string | null;
  spx_low: string | null;
  prev_close: string | null;
  median_hl_pct: string | null;
  opening_range_high: string | null;
  opening_range_low: string | null;
  opening_range_pct_consumed: string | null;
  opening_range_signal: string | null;
}

/** The two training_features columns a repair copies. */
export interface FeatureRow {
  opening_range_signal: string | null;
  opening_range_pct_consumed: string | null;
}

/** The four columns a repair moves, as text (a NUMERIC is read as text). */
export interface OrValues {
  high: string | null;
  low: string | null;
  consumed: string | null;
  signal: string | null;
}

export type SkipReason =
  | 'no-slot'
  | 'no-stored-range'
  | 'unreadable-stored-range'
  | 'no-as-of-state'
  | 'null-median'
  | 'unreadable-median'
  | 'no-spot'
  | 'cannot-grade'
  | 'consumed-overflow'
  | 'early-slot-no-candles'
  | 'ambiguous-own-range'
  | 'not-previous-range';

export interface RowRef {
  id: number;
  date: string;
  entryTime: string;
  /** Minutes after midnight CT; null for a label with no slot. */
  slotCT: number | null;
}

/** One 5-minute bar the as-of range read, for a hand check. */
export interface Bar {
  /** Start, ET, `H:MM`. */
  start: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Started by the slot but not ended: the band's upper side. */
  running: boolean;
}

export interface Evidence {
  source: 'candles' | 'own-range';
  /** The bars before 10:00 ET that had started by the slot. */
  bars: Bar[];
  spx: number | null;
  median: number | null;
  /** The range as of the slot; null where no bar had ended. */
  asOf: { high: number; low: number } | null;
  /** The live band: [low bound, high bound] of the high and of the low. */
  band: { high: [number, number]; low: [number, number] } | null;
}

/** A row a repair writes: the old and the new values, and what they rest on. */
interface Written {
  row: RowRef;
  before: OrValues;
  after: OrValues;
  evidence: Evidence;
}

export type RowResult =
  | ({ kind: 'repair' } & Written)
  | ({ kind: 'incomplete-range' } & Written)
  | { kind: 'ok'; row: RowRef; stored: OrValues }
  | {
      kind: 'rebase';
      row: RowRef;
      stored: { high: number; low: number };
      asOf: { high: number; low: number } | null;
    }
  | { kind: 'lag'; row: RowRef; stored: { high: number; low: number } }
  | { kind: 'look-ahead'; row: RowRef; stored: { high: number; low: number } }
  | {
      kind: 'skip';
      row: RowRef;
      reason: SkipReason;
      /** The row's range was stale, so the skip is a repair not made. */
      stale: boolean;
    };

/** A result an apply writes. */
export type WrittenResult = Extract<
  RowResult,
  { kind: 'repair' | 'incomplete-range' }
>;

export const isWritten = (r: RowResult): r is WrittenResult =>
  r.kind === 'repair' || r.kind === 'incomplete-range';

export type FeatureStatus =
  | { kind: 'none' }
  | {
      kind: 'copy';
      rowId: number;
      before: { signal: string | null; consumed: string | null };
      after: { signal: string | null; consumed: string | null };
    }
  | { kind: 'out-of-sync'; rowId: number }
  | { kind: 'no-features-row'; rowId: number };

/**
 * The spec's known limit, reported and never repaired: rows whose stored
 * `prev_close` is not the real previous session's close, which also puts the
 * row's other previous-session values in doubt (snapshot-builder phase 6's
 * scope). `expected` is null when /api/history did not report that session, so
 * nothing was checked.
 */
export interface PreviousCloseCheck {
  expected: number | null;
  off: Array<{ id: number; entryTime: string; stored: string }>;
}

export interface DatePlan {
  date: string;
  source: 'candles' | 'own-range' | 'skipped';
  skipped?: 'not-a-past-trading-day' | 'history-failed';
  detail?: string;
  rows: RowResult[];
  feature: FeatureStatus;
  /** Null for a date with no candles: its history was never asked. */
  previousClose: PreviousCloseCheck | null;
}

interface Range {
  high: number;
  low: number;
}

// ── Pure: reading stored values ─────────────────────────────────────────────

/** A stored DECIMAL as a number; null for NULL, 'bad' for NaN or text. */
function parseStored(raw: string | null): number | null | 'bad' {
  if (raw == null) return null;
  if (raw.trim() === '') return 'bad';
  const value = Number(raw);
  return Number.isFinite(value) ? value : 'bad';
}

const cents = (value: number): number => Math.round(value * 100);

/** Two prices that are the same within the 0.05 tolerance. */
const near = (a: number, b: number): boolean =>
  Math.abs(cents(a) - cents(b)) <= TOLERANCE_CENTS;

function refOf(row: RangeRow, slot: number): RowRef {
  return {
    id: row.id,
    date: row.date,
    entryTime: row.entry_time,
    slotCT: Number.isNaN(slot) ? null : slot,
  };
}

const skip = (
  ref: RowRef,
  reason: SkipReason,
  stale = false,
): Extract<RowResult, { kind: 'skip' }> => ({
  kind: 'skip',
  row: ref,
  reason,
  stale,
});

/** What the row stores now, for the report and the backup. */
function beforeOf(row: RangeRow): OrValues {
  return {
    high: row.opening_range_high,
    low: row.opening_range_low,
    consumed: row.opening_range_pct_consumed,
    signal: row.opening_range_signal,
  };
}

/** The consumed value as DECIMAL(6,4) text, or null when it does not fit. */
function consumedText(value: number): string | null {
  if (!Number.isFinite(value) || Math.abs(value) > CONSUMED_MAX) return null;
  return (Math.round(value * 10_000) / 10_000).toFixed(4);
}

const hhmm = (minutes: number): string =>
  `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;

/** The bars before 10:00 ET that had started by the slot, flagged if running. */
function barsFor(candles: readonly SlotCandle[], slotCT: number): Bar[] {
  const slotET = slotCT + ET_AHEAD_OF_CT_MIN;
  const bars: Bar[] = [];
  for (const c of candles) {
    const start = getETTotalMinutes(new Date(c.datetime));
    if (start >= OPENING_RANGE_END_MIN_ET || start > slotET) continue;
    bars.push({
      start: hhmm(start),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      running: start + BAR_MINUTES > slotET,
    });
  }
  return bars;
}

/**
 * The repair of a stale row to `asOf` (null at 8:30 CT: all four NULL), or the
 * skip that says why it is not made. The median is checked first: a NULL median,
 * or one that is not above 0, is never graded and never written to. Everything
 * the grade reads is finite here: `parseStored` returns only finite numbers, and
 * the as-of range comes from `spxSlotStateAsOf`, which rejects a bad price.
 */
function repairTo(
  row: RangeRow,
  ref: RowRef,
  asOf: Range | null,
  evidence: Omit<Evidence, 'spx' | 'median' | 'asOf'>,
): RowResult {
  const median = parseStored(row.median_hl_pct);
  if (median === null) return skip(ref, 'null-median', true);
  if (median === 'bad' || median <= 0) {
    return skip(ref, 'unreadable-median', true);
  }
  const spx = parseStored(row.spx);
  const full: Evidence = {
    ...evidence,
    spx: spx === 'bad' ? null : spx,
    median,
    asOf,
  };
  const before = beforeOf(row);
  if (asOf == null) {
    return {
      kind: 'repair',
      row: ref,
      before,
      after: { high: null, low: null, consumed: null, signal: null },
      evidence: full,
    };
  }
  // parseStored only returns finite numbers, so `<= 0` is the whole of "not > 0".
  if (spx == null || spx === 'bad' || spx <= 0) {
    return skip(ref, 'no-spot', true);
  }
  const reading = openingRangeSignal(asOf.high, asOf.low, spx, median);
  if (reading == null) return skip(ref, 'cannot-grade', true);
  const consumed = consumedText(reading.consumed);
  if (consumed == null) return skip(ref, 'consumed-overflow', true);
  return {
    kind: 'repair',
    row: ref,
    before,
    after: {
      high: toDecimal2(asOf.high),
      low: toDecimal2(asOf.low),
      consumed,
      signal: reading.signal,
    },
    evidence: full,
  };
}

/** The stored range as numbers, or the reason it cannot be read. */
function storedRange(row: RangeRow): Range | SkipReason {
  const high = parseStored(row.opening_range_high);
  const low = parseStored(row.opening_range_low);
  if (high === null && low === null) return 'no-stored-range';
  if (high == null || low == null || high === 'bad' || low === 'bad') {
    return 'unreadable-stored-range';
  }
  return { high, low };
}

// ── Pure: judging a row against its date's candles ──────────────────────────

/** A range a stored one may lie in: [low bound, high bound] of each side. */
interface Window {
  high: [number, number];
  low: [number, number];
}

const inWindow = (stored: Range, w: Window): boolean =>
  cents(stored.high) >= cents(w.high[0]) - TOLERANCE_CENTS &&
  cents(stored.high) <= cents(w.high[1]) + TOLERANCE_CENTS &&
  cents(stored.low) >= cents(w.low[0]) - TOLERANCE_CENTS &&
  cents(stored.low) <= cents(w.low[1]) + TOLERANCE_CENTS;

/**
 * Where a range a page that answered a bar behind lies at `slot`: from the
 * as-of range a bar earlier, widened by the open of the bar that ended at the
 * slot, to the as-of range at the slot. Null where no bar had ended at the
 * slot, or the bar that ended at it cannot be read.
 */
function lagWindow(
  candles: readonly SlotCandle[],
  slot: number,
): Window | null {
  const now = spxSlotStateAsOf(candles, slot)?.openingRange ?? null;
  if (now == null) return null;
  const earlier =
    spxSlotStateAsOf(candles, slot - BAR_MINUTES)?.openingRange ?? null;
  const endedAt = slot + ET_AHEAD_OF_CT_MIN - BAR_MINUTES;
  const ending = candles.find(
    (c) => getETTotalMinutes(new Date(c.datetime)) === endedAt,
  );
  if (ending == null || !Number.isFinite(ending.open)) return null;
  return {
    high: [Math.max(earlier?.high ?? ending.open, ending.open), now.high],
    low: [now.low, Math.min(earlier?.low ?? ending.open, ending.open)],
  };
}

function judgeWithCandles(
  row: RangeRow,
  candles: readonly SlotCandle[],
  previousOwn: OwnRange | null,
): RowResult {
  const slot = parseEntryTimeMinutes(row.entry_time);
  const ref = refOf(row, slot);
  if (Number.isNaN(slot)) return skip(ref, 'no-slot');
  const state = spxSlotStateAsOf(candles, slot);
  const stored = storedRange(row);
  // At a slot where no bar has ended, no range is due: a row that stores none
  // is right (it is what a repair at 8:30 CT writes, so a second run sees ok).
  if (
    stored === 'no-stored-range' &&
    state != null &&
    state.openingRange == null
  ) {
    return { kind: 'ok', row: ref, stored: beforeOf(row) };
  }
  if (typeof stored === 'string') return skip(ref, stored);

  if (state == null) return skip(ref, 'no-as-of-state');
  const asOf = state.openingRange;
  const open = state.runningOHLC.open;
  // With no ended bar the lower bound is the open, as the running range has it.
  const floor = asOf ?? { high: open, low: open };
  // The bar running at the slot is inside the band while the range is still
  // forming. If its state cannot be read (a bad price on it), the ceiling is
  // unknown: the row is left unjudged, not judged against the as-of range alone.
  const runningState = spxSlotStateAsOf(candles, slot + BAR_MINUTES);
  if (runningState == null && slot < COMPLETE_FROM_CT) {
    return skip(ref, 'no-as-of-state');
  }
  const running = runningState?.openingRange;
  const ceil = {
    high: Math.max(floor.high, running?.high ?? floor.high),
    low: Math.min(floor.low, running?.low ?? floor.low),
  };

  if (
    asOf != null &&
    near(stored.high, asOf.high) &&
    near(stored.low, asOf.low)
  ) {
    return { kind: 'ok', row: ref, stored: beforeOf(row) };
  }

  const early = slot < COMPLETE_FROM_CT;
  const live = row.is_backtest !== true;
  const complete = early
    ? (spxSlotStateAsOf(candles, COMPLETE_FROM_CT)?.openingRange ?? null)
    : asOf;
  if (!live && early) {
    // A replay before 10:00 ET may hold the date's whole range, read ahead.
    // Without that range (a bad price on a bar that has ended by 9:00 CT) it
    // cannot be told from a repairable row, so it is not judged.
    if (complete == null) return skip(ref, 'no-as-of-state');
    if (near(stored.high, complete.high) && near(stored.low, complete.low)) {
      return { kind: 'look-ahead', row: ref, stored };
    }
  }

  // A range that is the previous date's own is carried over, whatever window
  // it falls in by chance: it is stale, and it is repaired below.
  const carriedOver =
    previousOwn != null &&
    near(stored.high, previousOwn.high) &&
    near(stored.low, previousOwn.low);
  const band: Window = {
    high: [floor.high, ceil.high],
    low: [ceil.low, floor.low],
  };
  if (!carriedOver && inWindow(stored, band)) {
    return { kind: 'rebase', row: ref, stored, asOf };
  }
  // A page a bar behind: any slot before 10:00 ET, and from the live fix on
  // the 9:00 CT slot too, where the range completes. Before the fix that slot
  // is the incomplete-range kind below, which is written, not only counted.
  // Past 9:00 CT the window is only the complete range, which `ok` took above,
  // so the date test covers those slots without changing a result.
  const lagSlot = early || row.date >= LIVE_FIX_DATE;
  if (!carriedOver && live && lagSlot) {
    const window = lagWindow(candles, slot);
    if (window != null && inWindow(stored, window)) {
      return { kind: 'lag', row: ref, stored };
    }
  }

  const repair = repairTo(row, ref, asOf, {
    source: 'candles',
    bars: barsFor(candles, slot),
    band,
  });
  if (repair.kind !== 'repair') return repair;
  if (!carriedOver && live && !early && row.date < LIVE_FIX_DATE) {
    // The page's range at 10:00 ET lacked the 9:55 bar's last seconds.
    const window = lagWindow(candles, COMPLETE_FROM_CT);
    if (window != null && inWindow(stored, window)) {
      return { ...repair, kind: 'incomplete-range' };
    }
  }
  return repair;
}

// ── Pure: a date with no candles ────────────────────────────────────────────

export type OwnRange = Range;

/**
 * The range most of a date's rows at or after 10:00 ET hold, when at least two
 * do and no other range has as many; else null.
 */
export function ownRangeOf(rows: readonly RangeRow[]): OwnRange | null {
  const counts = new Map<string, { n: number; range: OwnRange }>();
  for (const row of rows) {
    const slot = parseEntryTimeMinutes(row.entry_time);
    if (Number.isNaN(slot) || slot < COMPLETE_FROM_CT) continue;
    const stored = storedRange(row);
    if (typeof stored === 'string') continue;
    const key = `${cents(stored.high)}/${cents(stored.low)}`;
    const entry = counts.get(key);
    if (entry) entry.n += 1;
    else counts.set(key, { n: 1, range: stored });
  }
  const ranked = [...counts.values()].sort((a, b) => b.n - a.n);
  const top = ranked[0];
  if (top == null || top.n < 2) return null;
  if (ranked[1] != null && ranked[1].n === top.n) return null;
  return top.range;
}

function judgeOwnRange(
  row: RangeRow,
  own: OwnRange | null,
  previousOwn: OwnRange | null,
): RowResult {
  const slot = parseEntryTimeMinutes(row.entry_time);
  const ref = refOf(row, slot);
  if (Number.isNaN(slot)) return skip(ref, 'no-slot');
  const stored = storedRange(row);
  if (typeof stored === 'string') return skip(ref, stored);

  if (slot < COMPLETE_FROM_CT) {
    // A partial range: with no candles there is nothing to compare it to.
    const differs =
      own != null &&
      !(near(stored.high, own.high) && near(stored.low, own.low));
    return differs
      ? skip(ref, 'early-slot-no-candles')
      : { kind: 'ok', row: ref, stored: beforeOf(row) };
  }
  if (own == null) return skip(ref, 'ambiguous-own-range');
  if (near(stored.high, own.high) && near(stored.low, own.low)) {
    return { kind: 'ok', row: ref, stored: beforeOf(row) };
  }
  // Positive evidence: the row holds the previous trading date's own range.
  const carriedOver =
    previousOwn != null &&
    near(stored.high, previousOwn.high) &&
    near(stored.low, previousOwn.low);
  if (!carriedOver) return skip(ref, 'not-previous-range', true);
  return repairTo(row, ref, own, { source: 'own-range', bars: [], band: null });
}

// ── Pure: the plan for one date ─────────────────────────────────────────────

const sameNumeric = (a: string | null, b: string | null): boolean => {
  if (a == null || b == null) return a == null && b == null;
  return Number(a) === Number(b);
};

const sameOr = (a: OrValues, b: OrValues): boolean =>
  sameNumeric(a.high, b.high) &&
  sameNumeric(a.low, b.low) &&
  sameNumeric(a.consumed, b.consumed) &&
  a.signal === b.signal;

/** `high/low/consumed/signal`, NULL written out, for a message. */
const showOr = (v: OrValues): string =>
  `${v.high ?? 'NULL'}/${v.low ?? 'NULL'}/${v.consumed ?? 'NULL'}/${v.signal ?? 'NULL'}`;

/** `signal/consumed` of a features row, NULL written out, for a message. */
const showFeature = (v: { signal: string | null; consumed: string | null }) =>
  `${v.signal ?? 'NULL'}/${v.consumed ?? 'NULL'}`;

/**
 * Whether the date's features row follows the pick row, the row
 * `build-features` takes (the repair never changes which one: it reads none of
 * these columns). A written pick row gets its two values copied, when the
 * features row holds its old ones. A pick row that needs no repair is not
 * written, and a features row that differs from it is reported.
 */
function featureStatus(
  rows: readonly RangeRow[],
  results: readonly RowResult[],
  feature: FeatureRow | null,
): FeatureStatus {
  const pick = pickFeatureSnapshot(rows);
  if (pick == null) return { kind: 'none' };
  const result = results.find((r) => r.row.id === pick.id);
  if (result == null) return { kind: 'none' };
  if (result.kind === 'ok') {
    if (feature == null) return { kind: 'none' };
    const follows =
      feature.opening_range_signal === result.stored.signal &&
      sameNumeric(feature.opening_range_pct_consumed, result.stored.consumed);
    return follows ? { kind: 'none' } : { kind: 'out-of-sync', rowId: pick.id };
  }
  if (!isWritten(result)) return { kind: 'none' };
  if (feature == null) return { kind: 'no-features-row', rowId: pick.id };
  const follows =
    feature.opening_range_signal === result.before.signal &&
    sameNumeric(feature.opening_range_pct_consumed, result.before.consumed);
  if (!follows) return { kind: 'out-of-sync', rowId: pick.id };
  return {
    kind: 'copy',
    rowId: pick.id,
    before: {
      signal: result.before.signal,
      consumed: result.before.consumed,
    },
    after: { signal: result.after.signal, consumed: result.after.consumed },
  };
}

/**
 * Judge every row of one date. `candles` null is a date before Schwab's bars:
 * the date's own range stands in, and a stale row is repaired to it only when it
 * holds `previousOwnRange`, the previous trading date's own range. With
 * candles, a row that holds that range is carried over and stale, whatever lag
 * window or band it falls in by chance. Rows are judged in id order. Never
 * throws.
 */
export function planDate(input: {
  date: string;
  rows: readonly RangeRow[];
  candles: readonly SlotCandle[] | null;
  feature: FeatureRow | null;
  /** The previous session's close from /api/history; null if it gave none. */
  previousClose: number | null;
  /** The previous trading date's own range, if its rows name one. */
  previousOwnRange?: OwnRange | null;
}): DatePlan {
  const rows = [...input.rows].sort((a, b) => a.id - b.id);
  const { candles } = input;
  const own = candles == null ? ownRangeOf(rows) : null;
  const previousOwn = input.previousOwnRange ?? null;
  const results = rows.map((row) =>
    candles == null
      ? judgeOwnRange(row, own, previousOwn)
      : judgeWithCandles(row, candles, previousOwn),
  );
  return {
    date: input.date,
    source: candles == null ? 'own-range' : 'candles',
    rows: results,
    feature: featureStatus(rows, results, input.feature),
    previousClose:
      candles == null ? null : checkPreviousClose(rows, input.previousClose),
  };
}

/**
 * Rows whose stored `prev_close` is further from the real previous close than
 * the G1b rule allows (snapshot-price-context.ts: 3.00, because the 5-minute
 * close and the official close differ by up to about 2.55 while a previous
 * close from the wrong week misses by tens to hundreds). A NULL is not listed:
 * nothing is stored to be wrong. A value that is not a number is.
 */
function checkPreviousClose(
  rows: readonly RangeRow[],
  expected: number | null,
): PreviousCloseCheck {
  if (expected == null) return { expected: null, off: [] };
  const off: PreviousCloseCheck['off'] = [];
  for (const row of rows) {
    const stored = parseStored(row.prev_close);
    if (stored === null) continue;
    const within =
      stored !== 'bad' &&
      Math.abs(cents(stored) - cents(expected)) <= SETTLEMENT_TOLERANCE_CENTS;
    if (!within) {
      off.push({
        id: row.id,
        entryTime: row.entry_time,
        stored: row.prev_close ?? '',
      });
    }
  }
  return { expected, off };
}

// ── Pure: counts ────────────────────────────────────────────────────────────

/** What one date comes to, for the per-date table. */
export interface DateCounts {
  rows: number;
  /** Stale repairs. */
  repairs: number;
  lag: number;
  lookAhead: number;
  incomplete: number;
  rebase: number;
  /** Stale rows left alone for a reason (NULL median, no spot, ...). */
  staleSkips: number;
  /** Rows the candles gave no as-of state for. */
  noAsOf: number;
}

export function countDate(plan: DatePlan): DateCounts {
  const c: DateCounts = {
    rows: plan.rows.length,
    repairs: 0,
    lag: 0,
    lookAhead: 0,
    incomplete: 0,
    rebase: 0,
    staleSkips: 0,
    noAsOf: 0,
  };
  for (const r of plan.rows) {
    if (r.kind === 'repair') c.repairs += 1;
    else if (r.kind === 'incomplete-range') c.incomplete += 1;
    else if (r.kind === 'lag') c.lag += 1;
    else if (r.kind === 'look-ahead') c.lookAhead += 1;
    else if (r.kind === 'rebase') c.rebase += 1;
    else if (r.kind === 'skip') {
      if (r.stale) c.staleSkips += 1;
      if (r.reason === 'no-as-of-state') c.noAsOf += 1;
    }
  }
  return c;
}

export interface Summary {
  dates: number;
  datesSkipped: number;
  rows: number;
  /** Stale repairs (not the incomplete-range kind). */
  repairs: number;
  /** Incomplete-range repairs: written, counted apart. */
  incomplete: number;
  /** Rows an apply writes: repairs plus incomplete-range ones. */
  writes: number;
  /** Stale rows: repaired, or left alone for a reason. */
  stale: number;
  rebase: number;
  lag: number;
  lookAhead: number;
  nullMedian: number;
  skipsByReason: Partial<Record<SkipReason, number>>;
  /** Rows a repair would change, by column. */
  byColumn: Record<'high' | 'low' | 'consumed' | 'signal', number>;
  featureCopies: number;
  /** Rows whose stored prev_close is not the real previous close (reported). */
  prevCloseOff: number;
  /** Dates whose previous session /api/history did not report. */
  datesPrevUnreported: number;
}

export function summarize(plans: readonly DatePlan[]): Summary {
  const s: Summary = {
    dates: plans.length,
    datesSkipped: 0,
    rows: 0,
    repairs: 0,
    incomplete: 0,
    writes: 0,
    stale: 0,
    rebase: 0,
    lag: 0,
    lookAhead: 0,
    nullMedian: 0,
    skipsByReason: {},
    byColumn: { high: 0, low: 0, consumed: 0, signal: 0 },
    featureCopies: 0,
    prevCloseOff: 0,
    datesPrevUnreported: 0,
  };
  for (const plan of plans) {
    if (plan.source === 'skipped') s.datesSkipped += 1;
    if (plan.feature.kind === 'copy') s.featureCopies += 1;
    if (plan.previousClose != null) {
      s.prevCloseOff += plan.previousClose.off.length;
      if (plan.previousClose.expected == null) s.datesPrevUnreported += 1;
    }
    for (const r of plan.rows) {
      s.rows += 1;
      if (r.kind === 'rebase') s.rebase += 1;
      if (r.kind === 'lag') s.lag += 1;
      if (r.kind === 'look-ahead') s.lookAhead += 1;
      if (r.kind === 'repair') {
        s.repairs += 1;
        s.stale += 1;
      }
      if (r.kind === 'incomplete-range') s.incomplete += 1;
      if (isWritten(r)) {
        s.writes += 1;
        for (const column of ['high', 'low', 'consumed', 'signal'] as const) {
          const before = r.before[column];
          const after = r.after[column];
          if (
            column === 'consumed'
              ? !sameNumeric(before, after)
              : before !== after
          ) {
            s.byColumn[column] += 1;
          }
        }
      }
      if (r.kind === 'skip') {
        s.skipsByReason[r.reason] = (s.skipsByReason[r.reason] ?? 0) + 1;
        if (r.stale) s.stale += 1;
        if (r.reason === 'null-median') s.nullMedian += 1;
      }
    }
  }
  return s;
}

// ── Reading the database ────────────────────────────────────────────────────

/** The dates with a stored opening range, in range, oldest first. */
async function readDates(
  sql: Sql,
  opts: { since: string | null; until: string | null },
): Promise<string[]> {
  const rows = (await withDbRetry(() =>
    sql.query(
      `SELECT DISTINCT to_char(date, 'YYYY-MM-DD') AS day
         FROM market_snapshots
        WHERE (opening_range_high IS NOT NULL OR opening_range_low IS NOT NULL)
          AND ($1::date IS NULL OR date >= $1::date)
          AND ($2::date IS NULL OR date <= $2::date)
        ORDER BY day`,
      [opts.since, opts.until],
    ),
  )) as Array<{ day: string }>;
  return rows.map((r) => r.day);
}

/** One date's rows, in id order, DECIMALs as text. */
async function readRows(sql: Sql, date: string): Promise<RangeRow[]> {
  return (await withDbRetry(() =>
    sql.query(
      `SELECT id, to_char(date, 'YYYY-MM-DD') AS date, entry_time,
              spx::text AS spx, spx_open::text AS spx_open,
              spx_high::text AS spx_high, spx_low::text AS spx_low,
              prev_close::text AS prev_close,
              median_hl_pct::text AS median_hl_pct,
              opening_range_high::text AS opening_range_high,
              opening_range_low::text AS opening_range_low,
              opening_range_pct_consumed::text AS opening_range_pct_consumed,
              opening_range_signal,
              ${SNAPSHOT_TRUST_COLUMNS_SQL}
         FROM market_snapshots
        WHERE date = $1::date
        ORDER BY id`,
      [date],
    ),
  )) as RangeRow[];
}

async function readFeature(sql: Sql, date: string): Promise<FeatureRow | null> {
  const rows = (await withDbRetry(() =>
    sql.query(
      `SELECT opening_range_signal,
              opening_range_pct_consumed::text AS opening_range_pct_consumed
         FROM training_features
        WHERE date = $1::date`,
      [date],
    ),
  )) as FeatureRow[];
  return rows[0] ?? null;
}

// ── Writes ──────────────────────────────────────────────────────────────────

/** One row of a plan or a backup: what the guarded UPDATE moves. */
export interface MoveRow {
  id: number;
  date: string;
  entryTime: string;
  kind: 'repair' | 'incomplete-range';
  before: OrValues;
  after: OrValues;
}

export interface MoveFeature {
  date: string;
  /** The market_snapshots row the copy is taken from, and must still hold it. */
  pickId: number;
  before: { signal: string | null; consumed: string | null };
  after: { signal: string | null; consumed: string | null };
}

function writesOf(plans: readonly DatePlan[]): MoveRow[] {
  return plans.flatMap((p) =>
    p.rows.flatMap((r) =>
      isWritten(r)
        ? [
            {
              id: r.row.id,
              date: r.row.date,
              entryTime: r.row.entryTime,
              kind: r.kind,
              before: r.before,
              after: r.after,
            },
          ]
        : [],
    ),
  );
}

function featureCopiesOf(plans: readonly DatePlan[]): MoveFeature[] {
  return plans.flatMap((p) =>
    p.feature.kind === 'copy'
      ? [
          {
            date: p.date,
            pickId: p.feature.rowId,
            before: p.feature.before,
            after: p.feature.after,
          },
        ]
      : [],
  );
}

const orColumn = (values: OrValues, column: keyof OrValues): string | null =>
  values[column];

/**
 * The guarded UPDATE of one chunk of rows, as a lazy query for a transaction.
 * Each row moves from its `from` values to its `to` values only where it still
 * holds `from` in every column the update touches (the text is cast to numeric
 * in SQL and compared with `IS NOT DISTINCT FROM`, so NULL matches NULL).
 * `apply` moves before -> after, `undo` after -> before.
 */
function rowsUpdate(
  sql: Sql,
  chunk: readonly MoveRow[],
  direction: 'apply' | 'undo',
) {
  const forward = direction === 'apply';
  const from = (column: keyof OrValues) =>
    chunk.map((r) => orColumn(forward ? r.before : r.after, column));
  const to = (column: keyof OrValues) =>
    chunk.map((r) => orColumn(forward ? r.after : r.before, column));
  return sql`
    UPDATE market_snapshots AS t
       SET opening_range_high = v.to_high::numeric,
           opening_range_low = v.to_low::numeric,
           opening_range_pct_consumed = v.to_pct::numeric,
           opening_range_signal = v.to_signal
      FROM unnest(
             ${chunk.map((r) => r.id)}::int[],
             ${from('high')}::text[], ${from('low')}::text[],
             ${from('consumed')}::text[], ${from('signal')}::text[],
             ${to('high')}::text[], ${to('low')}::text[],
             ${to('consumed')}::text[], ${to('signal')}::text[]
           ) AS v(id, from_high, from_low, from_pct, from_signal,
                  to_high, to_low, to_pct, to_signal)
     WHERE t.id = v.id
       AND t.opening_range_high IS NOT DISTINCT FROM v.from_high::numeric
       AND t.opening_range_low IS NOT DISTINCT FROM v.from_low::numeric
       AND t.opening_range_pct_consumed IS NOT DISTINCT FROM v.from_pct::numeric
       AND t.opening_range_signal IS NOT DISTINCT FROM v.from_signal
    RETURNING t.id
  `;
}

/**
 * The features row of a date, as a lazy query for the date's transaction. It
 * moves only where the features row still holds its `from` values AND the pick
 * row it follows holds the `to` values (the rows update ahead of it in the same
 * transaction wrote them), so a features row never follows a pick row that was
 * not written, or restored.
 */
function featuresUpdate(
  sql: Sql,
  copy: MoveFeature,
  direction: 'apply' | 'undo',
) {
  const forward = direction === 'apply';
  const from = forward ? copy.before : copy.after;
  const to = forward ? copy.after : copy.before;
  return sql`
    UPDATE training_features AS t
       SET opening_range_signal = v.to_signal,
           opening_range_pct_consumed = v.to_pct::numeric
      FROM unnest(
             ${[copy.date]}::date[], ${[copy.pickId]}::int[],
             ${[from.signal]}::text[], ${[from.consumed]}::text[],
             ${[to.signal]}::text[], ${[to.consumed]}::text[]
           ) AS v(date, pick_id, from_signal, from_pct, to_signal, to_pct)
     WHERE t.date = v.date
       AND t.opening_range_signal IS NOT DISTINCT FROM v.from_signal
       AND t.opening_range_pct_consumed IS NOT DISTINCT FROM v.from_pct::numeric
       AND EXISTS (
         SELECT 1 FROM market_snapshots m
          WHERE m.id = v.pick_id
            AND m.opening_range_signal IS NOT DISTINCT FROM v.to_signal
            AND m.opening_range_pct_consumed IS NOT DISTINCT FROM v.to_pct::numeric
       )
    RETURNING to_char(t.date, 'YYYY-MM-DD') AS day
  `;
}

/**
 * One date, all or nothing: its rows (500 to a statement, R5) and its features
 * row in one transaction. Ids that moved are added to `moved`, and the date to
 * `featuresMoved`, only when the transaction has committed. A transaction is not
 * retried: if its answer were lost after a commit, the retry would match nothing
 * and call the rows changed.
 */
async function commitDate(
  sql: Sql,
  rows: readonly MoveRow[],
  copy: MoveFeature | undefined,
  direction: 'apply' | 'undo',
  moved: Set<number>,
  featuresMoved: Set<string>,
): Promise<void> {
  const queries = [];
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    queries.push(rowsUpdate(sql, rows.slice(i, i + WRITE_CHUNK), direction));
  }
  const chunks = queries.length;
  if (copy != null) queries.push(featuresUpdate(sql, copy, direction));
  const results = (await sql.transaction(queries)) as unknown as Array<
    Array<{ id?: number; day?: string }>
  >;
  for (const rowsDone of results.slice(0, chunks)) {
    for (const r of rowsDone) if (r.id != null) moved.add(r.id);
  }
  for (const r of results[chunks] ?? []) {
    if (r.day != null) featuresMoved.add(r.day);
  }
}

const NullableText = z.string().nullable();
const OrValuesSchema = z.strictObject({
  high: NullableText,
  low: NullableText,
  consumed: NullableText,
  signal: NullableText,
});
const FeatureValuesSchema = z.strictObject({
  signal: NullableText,
  consumed: NullableText,
});
const DateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const RowsSchema = z.array(
  z.strictObject({
    id: z.number().int().positive().max(MAX_ID),
    date: DateText,
    entryTime: z.string(),
    kind: z.enum(['repair', 'incomplete-range']),
    before: OrValuesSchema,
    after: OrValuesSchema,
  }),
);
const FeaturesSchema = z.array(
  z.strictObject({
    date: DateText,
    pickId: z.number().int().positive().max(MAX_ID),
    before: FeatureValuesSchema,
    after: FeatureValuesSchema,
  }),
);
const BackupSchema = z.strictObject({
  note: z.string(),
  createdAt: z.string(),
  database: z.string(),
  scope: z.string(),
  rows: RowsSchema,
  features: FeaturesSchema,
});
const PlanSchema = z.strictObject({
  note: z.string(),
  createdAt: z.string(),
  database: z.string(),
  scope: z.strictObject({
    date: DateText.nullable(),
    since: DateText.nullable(),
    until: DateText.nullable(),
  }),
  summary: z.string(),
  rows: RowsSchema,
  features: FeaturesSchema,
});
type PlanFile = z.infer<typeof PlanSchema>;

const BACKUP_NOTE =
  'Backup of the opening-range columns a repair replaced. `--undo-file <this file> --apply` restores them, each only where the row still holds the new values.';
const PLAN_NOTE =
  'What a dry run would write. `--apply --plan <this file>` plans afresh and writes only if every row, the values it holds now and its new values are the same as here, and the file was written for this database. A plan that covers more than one date also needs `--all`: apply one date first.';

/**
 * A new JSON file, written with `wx`: a file already there is never
 * overwritten (a backup is the only record of an earlier run), and `flush` puts
 * it on disk before anything can need it.
 */
function writeNewFile(
  dir: string,
  prefix: string,
  scope: string,
  payload: object,
  now: Date,
): string {
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replaceAll(':', '-');
  const file = join(dir, `${prefix}-${scope}-${stamp}.json`);
  try {
    writeFileSync(file, JSON.stringify(payload), { flag: 'wx', flush: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `Refusing to overwrite ${file}. Nothing was written to the database.`,
        { cause: err },
      );
    }
    throw err;
  }
  return file;
}

/** What the file names say about the run's reach: a date, a range or all. */
function scopeLabel(scope: PlanFile['scope']): string {
  if (scope.date != null) return scope.date;
  if (scope.since == null && scope.until == null) return 'all';
  return `${scope.since ?? 'first'}..${scope.until ?? 'last'}`;
}

/**
 * Whether a plan reaches more than one date: its scope is not a single date
 * (`--date`, or `--since` and `--until` naming the same one). This is the scope
 * the dry run was given, not the dates that happened to need a write: a dry
 * run with no arguments is an all-dates plan even when one date has repairs.
 */
function coversManyDates(plan: Pick<PlanFile, 'scope'>): boolean {
  const { date, since, until } = plan.scope;
  if (date != null) return false;
  return !(since != null && since === until);
}

/** Read a JSON file this script wrote, or say it is not one. */
function readFileAs<T>(file: string, schema: z.ZodType<T>, what: string): T {
  try {
    return schema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`${file} is not a ${what} this script wrote: ${why}`, {
      cause: err,
    });
  }
}

// `databaseOf` and `NO_DATABASE` live in ./db-host.ts, which the options-volume
// repair shares. Re-exported, so this tool's tests and importers are unchanged.
export { databaseOf };

/**
 * Refuse a file written for another database than DATABASE_URL names, before
 * any connection. The message carries the name the file recorded and never the
 * one derived from DATABASE_URL, which no query has confirmed yet. A file that
 * records no usable name, or a DATABASE_URL that gives none, never matches.
 */
function requireSameDatabase(file: string, recorded: string): void {
  if (recorded === NO_DATABASE) {
    throw new Error(
      `${file} records no usable database name, so it cannot be matched to DATABASE_URL. Nothing was written.`,
    );
  }
  // `recorded` is not `NO_DATABASE` here, so a DATABASE_URL that names none
  // differs from it too: the sentinel can never match.
  if (databaseOf(process.env.DATABASE_URL) !== recorded) {
    throw new Error(
      `${file} was written for the database ${recorded}, and DATABASE_URL names a different database or is not a usable URL. Nothing was written.`,
    );
  }
}

/** Refuse a dry run, before `getDb()`, when DATABASE_URL names no usable database. */
function requireUsableDatabase(): void {
  if (databaseOf(process.env.DATABASE_URL) === NO_DATABASE) {
    throw new Error(
      'DATABASE_URL is missing or is not a usable database URL. Nothing was read or written.',
    );
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

export interface RunOptions {
  /** `YYYY-MM-DD`: only this date. */
  date: string | null;
  since: string | null;
  until: string | null;
  /**
   * Write. Needs `planFile`, whose scope replaces `date`, `since` and `until`.
   * Without it, `planFile` only checks the file against a fresh plan.
   */
  apply: boolean;
  planFile: string | null;
  /**
   * The owner's one-date-first rule: an apply of a plan that covers more than
   * one date needs this as a confirmation. A single-date plan does not.
   */
  all: boolean;
  backupDir: string;
}

export interface ApplyResult {
  backupFile: string | null;
  planned: number;
  written: number;
  /** Planned rows no statement wrote: they changed since the read. */
  changedSinceRead: number[];
  featuresPlanned: number;
  featuresWritten: number;
}

export interface RunResult {
  apply: boolean;
  dates: DatePlan[];
  backupFile: string | null;
  /** The plan file a dry run wrote, or the one `--plan` named. */
  planFile: string | null;
  applied: ApplyResult | null;
  /**
   * The database it read, `host/name`, derived from DATABASE_URL only after the
   * reads succeeded. The CLI prints this, not a name of its own taken earlier.
   */
  database: string;
}

/** A date the run does not plan: today or later, or not a trading day. */
function unplannable(date: string): DatePlan | null {
  if (date >= getETToday() || !isTradingDay(date)) {
    return {
      date,
      source: 'skipped',
      skipped: 'not-a-past-trading-day',
      rows: [],
      feature: { kind: 'none' },
      previousClose: null,
    };
  }
  return null;
}

/**
 * Read and plan every date in the scope. A date's history that cannot be read
 * skips that date, named. A refused cookie or a logged-out Schwab ends the run.
 * The cookie settings are needed, and the origin printed to stderr, only when a
 * date from FIRST_CANDLE_DATE on is planned.
 */
async function planDates(
  sql: Sql,
  dates: readonly string[],
): Promise<DatePlan[]> {
  let access: ReturnType<typeof historyAccess> | null = null;
  let fetched = false;
  const plans: DatePlan[] = [];
  for (const date of dates) {
    const skippedPlan = unplannable(date);
    if (skippedPlan != null) {
      plans.push(skippedPlan);
      continue;
    }
    const rows = await readRows(sql, date);
    let candles: readonly SlotCandle[] | null = null;
    let previousClose: number | null = null;
    if (date >= FIRST_CANDLE_DATE) {
      if (access == null) {
        access = historyAccess(process.env);
        console.error(`History origin: ${historyOrigin(process.env)}`);
      }
      if (fetched) await sleep(FETCH_PAUSE_MS);
      fetched = true;
      const history = await fetchHistory(access, date);
      if (history.kind === 'denied' || history.kind === 'logged-out') {
        throw new Error(
          history.kind === 'denied'
            ? `/api/history refused the owner cookie (HTTP ${history.status})`
            : `Schwab is logged out (/api/history answered ${history.status}): log in to Schwab again, then re-run`,
        );
      }
      if (history.kind === 'failed') {
        plans.push({
          date,
          source: 'skipped',
          skipped: 'history-failed',
          detail: history.detail,
          rows: [],
          feature: { kind: 'none' },
          previousClose: null,
        });
        continue;
      }
      candles = history.history.candles;
      previousClose = previousCloseOf(date, history.history.previousDay);
    }
    // The previous trading date's most common stored range: evidence of a
    // range carried over, for a date with candles and one without.
    const previousOwnRange = ownRangeOf(
      await readRows(sql, priorTradingDay(date)),
    );
    const feature = await readFeature(sql, date);
    plans.push(
      planDate({
        date,
        rows,
        candles,
        feature,
        previousClose,
        previousOwnRange,
      }),
    );
  }
  return plans;
}

/** What a plan file records: the writes, the feature copies, and a summary. */
function planSummary(plans: readonly DatePlan[]): string {
  const s = summarize(plans);
  return `Planned ${s.writes} writes (${s.repairs} repairs, ${s.incomplete} incomplete-range) and ${s.featureCopies} features copies over ${s.dates - s.datesSkipped} dates.`;
}

/**
 * The problems that make a fresh plan differ from the file the owner reviewed:
 * a row planned now that the file did not list, a row whose new values differ,
 * a listed row no longer planned (unless it already holds the file's new values:
 * a second apply writes nothing), and the same for the features copies. Empty
 * when the fresh plan writes exactly what the file says, or what is left of it.
 */
export function comparePlan(
  file: Pick<PlanFile, 'rows' | 'features'>,
  plans: readonly DatePlan[],
): string[] {
  const problems: string[] = [];
  const fresh = new Map<number, RowResult>();
  for (const p of plans) for (const r of p.rows) fresh.set(r.row.id, r);
  const listed = new Map(file.rows.map((r) => [r.id, r]));
  for (const r of fresh.values()) {
    if (!isWritten(r)) continue;
    const was = listed.get(r.row.id);
    if (was == null) {
      problems.push(`row ${r.row.id} is planned now and is not in the file`);
      continue;
    }
    if (!sameOr(was.after, r.after)) {
      problems.push(
        `row ${r.row.id}: the new values differ from the file's (${showOr(was.after)} then, ${showOr(r.after)} now)`,
      );
    }
    // The values the repair replaces are part of what was reviewed: a row that
    // changed to another stale value since would be overwritten unreviewed.
    if (!sameOr(was.before, r.before)) {
      problems.push(
        `row ${r.row.id}: the stored values changed since the dry run (${showOr(was.before)} then, ${showOr(r.before)} now)`,
      );
    }
  }
  for (const was of file.rows) {
    const now = fresh.get(was.id);
    if (now != null && isWritten(now)) continue;
    if (now?.kind === 'ok' && sameOr(now.stored, was.after)) continue;
    problems.push(
      `row ${was.id} (${was.date} ${was.entryTime}) is in the file and is no longer planned (now: ${now?.kind ?? 'not read'})`,
    );
  }
  const copies = new Map(
    plans.flatMap((p) =>
      p.feature.kind === 'copy' ? [[p.date, p.feature] as const] : [],
    ),
  );
  const status = new Map(plans.map((p) => [p.date, p.feature.kind]));
  for (const [date, copy] of copies) {
    const was = file.features.find((f) => f.date === date);
    if (
      was == null ||
      was.pickId !== copy.rowId ||
      was.after.signal !== copy.after.signal ||
      !sameNumeric(was.after.consumed, copy.after.consumed)
    ) {
      problems.push(`the features copy for ${date} differs from the file's`);
    } else if (
      was.before.signal !== copy.before.signal ||
      !sameNumeric(was.before.consumed, copy.before.consumed)
    ) {
      problems.push(
        `the features row for ${date} changed since the dry run (${showFeature(was.before)} then, ${showFeature(copy.before)} now)`,
      );
    }
  }
  for (const was of file.features) {
    if (copies.has(was.date)) continue;
    // Already copied: the pick row is fine and the features row follows it.
    if (status.get(was.date) === 'none') continue;
    problems.push(
      `the features copy for ${was.date} is in the file and is no longer planned (now: ${status.get(was.date) ?? 'date not read'})`,
    );
  }
  return problems;
}

/**
 * Read, plan and, with `apply`, write. A dry run reads the database and
 * `/api/history`, writes a plan file and nothing to the database. `--plan F`
 * plans afresh with F's scope and refuses unless the plan is F's; without
 * `apply` it only says so.
 */
export async function runRepair(opts: RunOptions): Promise<RunResult> {
  if (opts.apply && opts.planFile == null) {
    throw new Error(
      'Refusing to apply without --plan <dry-run file>: the dry run names what will be written.',
    );
  }
  const reviewed =
    opts.planFile == null
      ? null
      : readFileAs(opts.planFile, PlanSchema, 'dry-run plan');
  if (reviewed == null) requireUsableDatabase();
  else requireSameDatabase(opts.planFile ?? '', reviewed.database);
  if (
    opts.apply &&
    reviewed != null &&
    !opts.all &&
    coversManyDates(reviewed)
  ) {
    throw new Error(
      `${opts.planFile} covers more than one date (${scopeLabel(reviewed.scope)}). Apply one date first: dry-run with --date <date> and apply that plan. To apply every date in this plan, add --all. Nothing was written.`,
    );
  }
  const scope = reviewed?.scope ?? {
    date: opts.date,
    since: opts.since,
    until: opts.until,
  };

  const sql = getDb();
  const dates = await readDates(sql, {
    since: scope.date ?? scope.since,
    until: scope.date ?? scope.until,
  });
  if (dates.length === 0) {
    throw new Error(
      'no market_snapshots rows with an opening range in that range',
    );
  }
  const plans = await planDates(sql, dates);
  // Queries on this URL have succeeded (the dates, every date's rows): from
  // here its name may be printed and written, and not before.
  const database = databaseOf(process.env.DATABASE_URL);

  if (reviewed != null) {
    const problems = comparePlan(reviewed, plans);
    if (problems.length > 0) {
      const shown = problems.slice(0, 10).join('\n  ');
      const more =
        problems.length > 10 ? `\n  ... and ${problems.length - 10} more` : '';
      throw new Error(
        `A fresh plan is not the plan in ${opts.planFile}. Nothing was written.\n  ${shown}${more}`,
      );
    }
    if (!opts.apply) {
      return {
        apply: false,
        dates: plans,
        backupFile: null,
        planFile: opts.planFile,
        applied: null,
        database,
      };
    }
    const applied = await applyPlans(sql, plans, {
      backupDir: opts.backupDir,
      scope: scopeLabel(scope),
      database,
    });
    return {
      apply: true,
      dates: plans,
      backupFile: applied.backupFile,
      planFile: opts.planFile,
      applied,
      database,
    };
  }

  const planFile = writeNewFile(
    opts.backupDir,
    'dry-run',
    scopeLabel(scope),
    {
      note: PLAN_NOTE,
      createdAt: new Date().toISOString(),
      database,
      scope,
      summary: planSummary(plans),
      rows: writesOf(plans),
      features: featureCopiesOf(plans),
    } satisfies PlanFile,
    new Date(),
  );
  return {
    apply: false,
    dates: plans,
    backupFile: null,
    planFile,
    applied: null,
    database,
  };
}

/**
 * The backup first, then each date in one transaction. Nothing to write writes
 * no backup. A failure part-way rolls back the date it was in, leaves the dates
 * before it written, and throws with what is and is not done, the backup and
 * the undo command.
 */
async function applyPlans(
  sql: Sql,
  plans: readonly DatePlan[],
  ctx: { backupDir: string; scope: string; database: string },
): Promise<ApplyResult> {
  const rows = writesOf(plans);
  const features = featureCopiesOf(plans);
  if (rows.length === 0) {
    return {
      backupFile: null,
      planned: 0,
      written: 0,
      changedSinceRead: [],
      featuresPlanned: 0,
      featuresWritten: 0,
    };
  }
  const backupFile = writeNewFile(
    ctx.backupDir,
    'backup',
    ctx.scope,
    {
      note: BACKUP_NOTE,
      createdAt: new Date().toISOString(),
      database: ctx.database,
      scope: ctx.scope,
      rows,
      features,
    } satisfies z.infer<typeof BackupSchema>,
    new Date(),
  );
  const moved = new Set<number>();
  const featuresMoved = new Set<string>();
  for (const date of new Set(rows.map((r) => r.date))) {
    try {
      await commitDate(
        sql,
        rows.filter((r) => r.date === date),
        features.find((f) => f.date === date),
        'apply',
        moved,
        featuresMoved,
      );
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      const notCopied = features
        .map((f) => f.date)
        .filter((d) => !featuresMoved.has(d));
      throw new Error(
        `${why}. The apply did not complete: wrote ${moved.size} of ${rows.length} planned rows (each date is one transaction, and ${date}'s was rolled back); training_features not copied for ${notCopied.join(', ') || 'no date'}. Backup: ${backupFile}. To undo what was written: npx tsx scripts/repair-stale-opening-range.ts --undo-file ${backupFile} --apply`,
        { cause: err },
      );
    }
  }
  return {
    backupFile,
    planned: rows.length,
    written: moved.size,
    changedSinceRead: rows.filter((r) => !moved.has(r.id)).map((r) => r.id),
    featuresPlanned: features.length,
    featuresWritten: featuresMoved.size,
  };
}

export interface UndoResult {
  apply: boolean;
  rows: number;
  restored: number;
  changedSince: number[];
  features: number;
  featuresRestored: number;
  /**
   * The database the backup was written for, as the file recorded it. It
   * matched DATABASE_URL's, so it is the one named, and it is not taken from
   * the URL.
   */
  database: string;
}

/**
 * Restore a backup, one date at a time: each row only where it still holds the
 * values the repair wrote, and a features row only together with its pick row.
 * Without `apply` it only counts what the file holds. A backup written for
 * another database is refused, counting or not.
 */
export async function runUndo(opts: {
  file: string;
  apply: boolean;
}): Promise<UndoResult> {
  const parsed = readFileAs(opts.file, BackupSchema, 'backup');
  requireSameDatabase(opts.file, parsed.database);
  const base = {
    apply: opts.apply,
    rows: parsed.rows.length,
    features: parsed.features.length,
    database: parsed.database,
  };
  if (!opts.apply) {
    return { ...base, restored: 0, changedSince: [], featuresRestored: 0 };
  }
  const sql = getDb();
  const moved = new Set<number>();
  const featuresMoved = new Set<string>();
  for (const date of new Set(parsed.rows.map((r) => r.date))) {
    try {
      await commitDate(
        sql,
        parsed.rows.filter((r) => r.date === date),
        parsed.features.find((f) => f.date === date),
        'undo',
        moved,
        featuresMoved,
      );
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${why}. The undo did not complete: restored ${moved.size} of ${parsed.rows.length} rows (${date}'s transaction was rolled back). Run the same command again: a row already restored is skipped.`,
        { cause: err },
      );
    }
  }
  return {
    ...base,
    restored: moved.size,
    changedSince: parsed.rows.filter((r) => !moved.has(r.id)).map((r) => r.id),
    featuresRestored: featuresMoved.size,
  };
}

export function exitCodeOf(result: RunResult): 0 | 1 {
  if (result.dates.some((d) => d.skipped === 'history-failed')) return 1;
  const a = result.applied;
  // A guarded write that matched nothing (a row, or a features row, that
  // changed since the read) is a run that did not do what it planned.
  const short =
    a != null &&
    (a.changedSinceRead.length > 0 ||
      a.written < a.planned ||
      a.featuresWritten < a.featuresPlanned);
  return short ? 1 : 0;
}

export function exitCodeOfUndo(result: UndoResult): 0 | 1 {
  return result.apply &&
    (result.changedSince.length > 0 ||
      result.restored < result.rows ||
      result.featuresRestored < result.features)
    ? 1
    : 0;
}

// ── Arguments ───────────────────────────────────────────────────────────────

export interface CliArgs {
  apply: boolean;
  /** Confirms an apply of a plan that covers more than one date. */
  all: boolean;
  date: string | null;
  since: string | null;
  until: string | null;
  planFile: string | null;
  undoFile: string | null;
  backupDir: string;
  envFile: string | null;
  help: boolean;
}

export const USAGE = `Usage: npx tsx scripts/repair-stale-opening-range.ts [--date D | --since D --until D]
       npx tsx scripts/repair-stale-opening-range.ts --plan <dry-run file> [--apply]
       npx tsx scripts/repair-stale-opening-range.ts --undo-file <backup> [--apply]

Repairs the opening range stored on market_snapshots rows that was stale when
saved: a previous session's range, from a page loaded before the day's first bar
or a tab left open. Every row of every date is checked against its own date's
candles (Schwab's 5-minute $SPX bars, from /api/history; needs APP_URL and
OWNER_SECRET, only for a date from 2026-03-05 on) and each row is one of:
  ok            the range as of its slot
  rebase        inside [that range, the range with the bar running at the
                slot]: counted, never written
  lag           a live row a bar behind the as-of range, before 10:00 ET, or
                at 9:00 CT from 2026-11-23 on: counted and listed, never
                written
  look-ahead    a replayed row before 10:00 ET holding the date's complete
                range: counted and listed, never written
  incomplete    a live row from 10:00 ET on, before 2026-11-23, narrower than
                the complete range only by the 9:55 bar's last seconds:
                written, counted apart (the owner's call, 2026-11-25)
  stale         anything else outside the band: written, and so is a row that
                holds the previous trading date's own range, which is a
                carried-over page whatever window it falls in
A written row gets all four columns (high, low, pct consumed and signal, graded
by the same function the live page uses). A row with a NULL median_hl_pct, or
one not above 0, is not graded: it is listed on its own and nothing is written
to it. Dates before 2026-03-05, which have no candles, take the date's own
range from its other rows at or after 10:00 ET, and repair a row only if it
holds the previous trading date's own range.

The dry run is the default: it reads the database DATABASE_URL points at
(production, in .env.local) and writes nothing to it. It prints the counts, a
per-date table, a block for every repair with the stored and the new values and
the candles used, the lists by id, and the rows whose stored prev_close is not
the real previous session's close (reported only). It writes a plan file under
${BACKUP_DIR}/. --apply needs --plan <that file>: it plans afresh, refuses
unless every row, the values it holds now and its new values are the file's (and
the file was written for this database, host and name), writes a backup file
under ${BACKUP_DIR}/ first (never overwriting one), then each date's rows (500
to a statement) and features row in one transaction, each row only where it
still holds the values the dry run read. --plan without --apply only checks the
file.

One date first: a plan whose scope covers more than one date (a dry run with no
--date, or a --since and --until range of more than one day) is applied only
with --all as well. Dry-run one date with --date, apply that plan, then the rest.

Options:
  --date <D>         only this date, YYYY-MM-DD
  --since <D>        first date to cover, YYYY-MM-DD
  --until <D>        last date to cover, YYYY-MM-DD (never today or later)
  --plan <f>         a dry-run file: check it, or with --apply write it
  --apply            write the plan named by --plan
  --all              with --apply --plan: confirm a plan that covers more than
                     one date (apply one date first, then this)
  --dry-run          the default, said aloud; contradicts --apply
  --undo-file <f>    restore a backup (with --apply; without it, only counts)
  --backup-dir <d>   where the plan and the backup go (default ${BACKUP_DIR})
  --env-file <path>  .env.local to load (default: the nearest one up the tree)
  --help, -h         print this and exit`;

const IsoDate = /^\d{4}-\d{2}-\d{2}$/;

function checkDate(flag: string, value: string | undefined): string {
  if (value == null || value.startsWith('--')) {
    throw new Error(`${flag} needs a value`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !IsoDate.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${flag} must be a real date, YYYY-MM-DD (got "${value}")`);
  }
  return value;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    apply: false,
    all: false,
    date: null,
    since: null,
    until: null,
    planFile: null,
    undoFile: null,
    backupDir: BACKUP_DIR,
    envFile: null,
    help: false,
  };
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    switch (flag) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--apply':
        args.apply = true;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--all':
        args.all = true;
        break;
      case '--date':
        args.date = checkDate(flag, next);
        i += 1;
        break;
      case '--since':
        args.since = checkDate(flag, next);
        i += 1;
        break;
      case '--until':
        args.until = checkDate(flag, next);
        i += 1;
        break;
      case '--plan':
      case '--undo-file':
      case '--backup-dir':
      case '--env-file': {
        if (next == null || next.startsWith('--')) {
          throw new Error(`${flag} needs a value`);
        }
        if (flag === '--plan') args.planFile = next;
        else if (flag === '--undo-file') args.undoFile = next;
        else if (flag === '--backup-dir') args.backupDir = next;
        else args.envFile = next;
        i += 1;
        break;
      }
      default:
        throw new Error(`unknown argument ${flag ?? ''}. Try --help.`);
    }
  }
  if (args.help) return args;
  if (dryRun && args.apply) {
    throw new Error('--dry-run and --apply contradict each other');
  }
  if (args.date != null && (args.since != null || args.until != null)) {
    throw new Error('--date cannot be combined with --since or --until');
  }
  if (
    args.planFile != null &&
    (args.date != null ||
      args.since != null ||
      args.until != null ||
      args.undoFile != null)
  ) {
    throw new Error(
      '--plan names its own scope: it contradicts --date, --since, --until and --undo-file',
    );
  }
  if (args.apply && args.undoFile == null && args.planFile == null) {
    throw new Error(
      'Refusing to apply without --plan <dry-run file>: the dry run names what will be written',
    );
  }
  if (args.all && !(args.apply && args.planFile != null)) {
    throw new Error(
      '--all only confirms --apply --plan <dry-run file>: it lets a plan that covers more than one date be applied. Apply one date first',
    );
  }
  return args;
}

// ── The report ──────────────────────────────────────────────────────────────

const price = (value: number | null): string =>
  value == null ? 'none' : value.toFixed(2);
const shown = (value: string | null): string => value ?? 'NULL';
const rowLabel = (ref: RowRef): string =>
  `id ${ref.id}  ${ref.date} ${ref.entryTime}`;

const SKIP_TEXT: Record<SkipReason, string> = {
  'no-slot': 'a label with no slot (pre-market)',
  'no-stored-range': 'no stored opening range',
  'unreadable-stored-range': 'a stored range with one side NULL or NaN',
  'no-as-of-state':
    'the candles give no as-of state (a slot before the open, a first bar that is not 9:30 ET, or a bad price on a bar the slot needs)',
  'null-median':
    'a stale range with a NULL median_hl_pct: not graded, nothing written',
  'unreadable-median':
    'a stale range with a median that is not a number above 0: not graded, nothing written',
  'no-spot':
    'a stale range whose stored spot is not a usable price: not graded',
  'cannot-grade': 'a stale range the grade function reads as null: not graded',
  'consumed-overflow':
    'a stale range whose consumed value would overflow DECIMAL(6,4)',
  'early-slot-no-candles':
    'a row before 10:00 ET on a date with no candles that differs from the date’s own range',
  'ambiguous-own-range':
    'a date with no candles and no single range most of its rows hold',
  'not-previous-range':
    'a stale range on a date with no candles that is not the previous trading date’s own range: no evidence it was carried over',
};

function barLine(bar: Bar): string {
  const tail = bar.running ? ' (running)' : '';
  return `${bar.start} o${price(bar.open)} h${price(bar.high)} l${price(bar.low)} c${price(bar.close)}${tail}`;
}

/** The per-row block: stored values, new values, and what they came from. */
function repairLines(r: WrittenResult): string[] {
  const e = r.evidence;
  const kind = r.kind === 'incomplete-range' ? '  [incomplete-range]' : '';
  const lines = [
    `  ${rowLabel(r.row)}  spx ${e.spx == null ? 'none' : e.spx.toFixed(2)}  median ${e.median == null ? 'none' : e.median.toFixed(4)}${kind}`,
    `    stored  high ${shown(r.before.high)}  low ${shown(r.before.low)}  consumed ${shown(r.before.consumed)}  signal ${shown(r.before.signal)}`,
    `    new     high ${shown(r.after.high)}  low ${shown(r.after.low)}  consumed ${shown(r.after.consumed)}  signal ${shown(r.after.signal)}`,
  ];
  if (e.source === 'own-range') {
    lines.push(
      `    source  the date's own range (no candles): ${price(e.asOf?.high ?? null)} / ${price(e.asOf?.low ?? null)}`,
    );
    return lines;
  }
  const asOfText = e.asOf
    ? `${price(e.asOf.high)} / ${price(e.asOf.low)}`
    : 'no bar had ended: NULL';
  const bandText = e.band
    ? `   band high [${price(e.band.high[0])}, ${price(e.band.high[1])}] low [${price(e.band.low[0])}, ${price(e.band.low[1])}]`
    : '';
  lines.push(`    as of   ${asOfText}${bandText}`);
  lines.push(`    bars    ${e.bars.map(barLine).join(' | ')}`);
  return lines;
}

/** `ids 1, 2, 3`, all of them: the owner reads each list to the end. */
const idList = (ids: readonly number[]): string => `ids ${ids.join(', ')}`;

/** The rows of one kind, as `date: ids ...` lines under a heading. */
function listByDate(
  out: string[],
  heading: string,
  plans: readonly DatePlan[],
  pick: (r: RowResult) => boolean,
): void {
  const byDate = plans
    .map((p) => ({
      date: p.date,
      ids: p.rows.filter(pick).map((r) => r.row.id),
    }))
    .filter((d) => d.ids.length > 0);
  const total = byDate.reduce((n, d) => n + d.ids.length, 0);
  if (total === 0) return;
  out.push('', `${heading} (${total}):`);
  for (const d of byDate) out.push(`  ${d.date}: ${idList(d.ids)}`);
}

const pad = (text: string | number, width: number): string =>
  String(text).padEnd(width);

/** One line a date, for the owner to see where the rows are. */
function dateTable(plans: readonly DatePlan[]): string[] {
  const header =
    'date        source      rows  repairs  lag  look-ahead  incomplete  rebase  stale-skips  no-as-of-state  features';
  const lines = [header];
  for (const p of plans) {
    const c = countDate(p);
    lines.push(
      [
        pad(p.date, 12),
        pad(p.source, 12),
        pad(c.rows, 6),
        pad(c.repairs, 9),
        pad(c.lag, 5),
        pad(c.lookAhead, 12),
        pad(c.incomplete, 12),
        pad(c.rebase, 8),
        pad(c.staleSkips, 13),
        pad(c.noAsOf, 16),
        p.feature.kind,
      ]
        .join('')
        .trimEnd(),
    );
  }
  return lines;
}

export function formatReport(result: {
  apply: boolean;
  dates: readonly DatePlan[];
  backupFile: string | null;
  planFile?: string | null;
}): string {
  const s = summarize(result.dates);
  const out: string[] = [];
  out.push(
    result.apply
      ? 'Stale opening-range repair: APPLY (the rows below are planned; APPLIED below says what was written)'
      : 'Stale opening-range repair: DRY RUN (nothing was written to the database)',
  );
  out.push(
    `Dates read: ${s.dates} (${s.dates - s.datesSkipped} planned, ${s.datesSkipped} skipped). Rows judged: ${s.rows}.`,
  );
  out.push(
    `Stale rows: ${s.stale}. Repairs planned: ${s.repairs}. Incomplete-range repairs planned: ${s.incomplete}. Rows written by an apply: ${s.writes}.`,
  );
  out.push(
    `Left alone and counted: as-of rebase (inside the band, differs from the as-of range): ${s.rebase}. Lag (a bar behind): ${s.lag}. Look-ahead (a replay holding the complete range): ${s.lookAhead}.`,
  );
  out.push(
    `Written rows by column: opening_range_high ${s.byColumn.high}, opening_range_low ${s.byColumn.low}, opening_range_pct_consumed ${s.byColumn.consumed}, opening_range_signal ${s.byColumn.signal}. training_features copies: ${s.featureCopies}.`,
  );
  const reasons = Object.entries(s.skipsByReason)
    .map(([reason, n]) => `${reason} ${n}`)
    .join(', ');
  out.push(`Rows left alone, by reason: ${reasons || 'none'}.`);
  out.push('', ...dateTable(result.dates));

  for (const plan of result.dates) {
    if (plan.source === 'skipped') {
      const detail = plan.detail ? `: ${plan.detail}` : '';
      out.push(`Date skipped: ${plan.date} (${plan.skipped}${detail})`);
    }
  }

  const written = result.dates.flatMap((p) => p.rows.filter(isWritten));
  if (written.length > 0) {
    out.push('', 'Repairs (stored -> new, with the candles used):');
    for (const r of written) out.push(...repairLines(r));
  }

  listByDate(
    out,
    'Incomplete-range rows, written by an apply (the 9:55 bar’s last seconds are missing)',
    result.dates,
    (r) => r.kind === 'incomplete-range',
  );
  listByDate(
    out,
    'Lag rows, not written (a live page a bar behind)',
    result.dates,
    (r) => r.kind === 'lag',
  );
  listByDate(
    out,
    'Look-ahead rows, not written (a replay that read the whole day; snapshot-builder phase 6)',
    result.dates,
    (r) => r.kind === 'look-ahead',
  );

  const nullMedian = result.dates.flatMap((p) =>
    p.rows.filter((r) => r.kind === 'skip' && r.reason === 'null-median'),
  );
  if (nullMedian.length > 0) {
    out.push(
      '',
      `Stale rows with a NULL median_hl_pct (${nullMedian.length}): not graded, NOTHING written to them:`,
    );
    for (const r of nullMedian) out.push(`  ${rowLabel(r.row)}`);
  }

  // Every other skip, by id with its reason, grouped by date and reason.
  const skips = result.dates.flatMap((p) =>
    p.rows.filter(
      (r): r is Extract<RowResult, { kind: 'skip' }> =>
        r.kind === 'skip' && r.reason !== 'null-median',
    ),
  );
  if (skips.length > 0) {
    out.push('', `Rows left alone, by id (${skips.length}):`);
    const groups = new Map<string, { ids: number[]; reason: SkipReason }>();
    for (const r of skips) {
      const key = `${r.row.date}\u0000${r.reason}`;
      const group = groups.get(key) ?? { ids: [], reason: r.reason };
      group.ids.push(r.row.id);
      groups.set(key, group);
    }
    for (const [key, group] of groups) {
      const date = key.split('\u0000')[0] ?? '';
      out.push(
        `  ${date}  ${group.reason} (${group.ids.length}): ${idList(group.ids)}  -- ${SKIP_TEXT[group.reason]}`,
      );
    }
  }

  const outOfSync = result.dates.filter(
    (p) =>
      p.feature.kind === 'out-of-sync' || p.feature.kind === 'no-features-row',
  );
  if (outOfSync.length > 0) {
    out.push('', 'Pick rows whose training_features row is not in step:');
    for (const p of outOfSync) {
      out.push(
        `  ${p.date}: ${p.feature.kind === 'out-of-sync' ? 'the features row holds other values than the pick row, so nothing was copied' : 'no features row'}`,
      );
    }
  }
  const prevOff = result.dates.flatMap((p) =>
    p.previousClose != null &&
    p.previousClose.expected != null &&
    p.previousClose.off.length > 0
      ? [
          {
            date: p.date,
            expected: p.previousClose.expected,
            off: p.previousClose.off,
          },
        ]
      : [],
  );
  if (prevOff.length > 0) {
    out.push(
      '',
      `Rows whose stored prev_close is not the real previous session's close (${s.prevCloseOff}; reported, never repaired, for snapshot-builder phase 6):`,
    );
    for (const p of prevOff) {
      const ids = p.off.slice(0, LISTED_IDS).map((o) => o.id);
      const more =
        p.off.length > LISTED_IDS
          ? `, and ${p.off.length - LISTED_IDS} more`
          : '';
      const first = p.off[0]?.stored ?? '';
      out.push(
        `  ${p.date}: real previous close ${p.expected.toFixed(2)}, ${p.off.length} rows off (first stored ${first}): ids ${ids.join(', ')}${more}`,
      );
    }
  }
  const unreported = result.dates.filter(
    (p) => p.previousClose != null && p.previousClose.expected == null,
  );
  if (unreported.length > 0) {
    out.push(
      '',
      `Previous session not reported by /api/history, so prev_close was not checked: ${unreported.map((p) => p.date).join(', ')}`,
    );
  }
  if (result.planFile != null) out.push('', `Plan file: ${result.planFile}`);
  if (result.backupFile != null) out.push('', `Backup: ${result.backupFile}`);
  return out.join('\n');
}

export function formatApplyReport(applied: ApplyResult): string {
  const out = [
    `APPLIED: ${applied.written} of ${applied.planned} planned rows written. Features rows copied: ${applied.featuresWritten} of ${applied.featuresPlanned}.`,
  ];
  if (applied.backupFile != null) out.push(`Backup: ${applied.backupFile}`);
  if (applied.changedSinceRead.length > 0) {
    out.push(
      `Rows that changed since the read, so not written: ${applied.changedSinceRead.join(', ')}`,
    );
  }
  return out.join('\n');
}

export function formatUndoReport(result: UndoResult): string {
  if (!result.apply) {
    return `Undo (nothing written): the backup holds ${result.rows} rows and ${result.features} features rows. Add --apply to restore them.`;
  }
  const out = [
    `UNDONE: ${result.restored} of ${result.rows} rows restored. Features rows restored: ${result.featuresRestored} of ${result.features} (a features row is restored only with its pick row).`,
  ];
  if (result.changedSince.length > 0) {
    out.push(
      `Rows that do not hold the repaired values, so not restored (changed since, or never written): ${result.changedSince.join(', ')}`,
    );
  }
  return out.join('\n');
}
