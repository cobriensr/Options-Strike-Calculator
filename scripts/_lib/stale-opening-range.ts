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
 * Which rows are stale. The as-of range at a row's slot is the range of the
 * bars that have ended by the slot (`spxSlotStateAsOf`, the owner's as-of
 * rule: NULL at 8:30 CT, partial until 9:00 CT). A live save before 10:00 ET
 * legitimately held a range that took in the bar still running at its slot,
 * and one that saw that bar part-formed, so "differs from the as-of range" is
 * not the test. A row is stale when its stored high is outside [as-of high,
 * high with the running bar], or its stored low is outside the mirror
 * interval, each with a 0.05 tolerance (prices are stored to 2 decimals). At
 * 8:30 CT, with no ended bar, the lower bound is the open. A previous
 * session's range always fails. A row inside the band that still differs from
 * the as-of range is an "as-of rebase": counted, never written (a methodology
 * question for the owner, not this bug).
 *
 * What a stale row gets. All four columns are recomputed: high and low from the
 * as-of range (all four NULL at 8:30 CT), and `opening_range_pct_consumed` and
 * `opening_range_signal` from `openingRangeSignal` (src/utils), the same
 * function the live hook calls, with the row's stored `spx` and
 * `median_hl_pct`. A row with a NULL `median_hl_pct` is NOT graded and
 * NOTHING is written to it, whatever its range: the function would read a
 * missing median as 1, which is a guessed value, so such a row goes in its own
 * list for the owner. A stale row whose spot is unusable is listed the same
 * way. Nothing is half-repaired.
 *
 * Dates before Schwab's 5-minute candles (before FIRST_CANDLE_DATE: the Feb
 * replay rows whose range came from a previous date) have no candles. They take
 * the date's own range from its other rows: the stored range most of the date's
 * rows at or after 10:00 ET hold, when at least two do and no other range
 * ties. A row at or after 10:00 ET that differs is repaired to it; a row before
 * 10:00 ET that differs is reported, not repaired (its partial range has no
 * candles to come from).
 *
 * `training_features`: when the row `build-features` picks for a repaired date
 * (`pickFeatureSnapshot`) is itself repaired, and the date's features row still
 * holds that row's old signal and consumed value, those two columns are copied
 * from the repaired row, under the same guard (the values read), the way the
 * feature trust repair does it, and not by a full rebuild, which would move
 * other columns.
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
 * 5-minute bars, which is what the page computed its range from. The spec names
 * scripts/_lib/schwab-local.mjs for them; it reads the production Redis token
 * record and may refresh it, which can race the crons, so this script asks the
 * app instead. The database's `spx_candles_1m` is SPY-translated and is not
 * them. The environment is DATABASE_URL, APP_URL and OWNER_SECRET, none of them
 * printed (the database host and the origin are). A date before Schwab's depth
 * needs neither of the last two.
 *
 * Dry run is the default and writes nothing. `--apply` needs `--date D` (one
 * date, the first run) or `--all`; it plans afresh, writes the backup file, and
 * only then the rows, 500 to a statement (R5), each only where the row still
 * holds the values the read found (R6), so a row that changed since is listed
 * and left alone. The backup is created with `wx`: an existing file is never
 * overwritten, and the run stops before any write. `--undo-file F --apply`
 * restores the old values under the reverse guard.
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
import {
  FETCH_PAUSE_MS,
  fetchHistory,
  historyAccess,
  previousCloseOf,
  SETTLEMENT_TOLERANCE_CENTS,
  toDecimal2,
  WRITE_CHUNK,
} from './snapshot-price-context.js';

type Sql = ReturnType<typeof getDb>;

/** Where the backup files go, relative to the working directory. */
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
  | 'ambiguous-own-range';

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

export type RowResult =
  | {
      kind: 'repair';
      row: RowRef;
      before: OrValues;
      after: OrValues;
      evidence: Evidence;
    }
  | { kind: 'ok'; row: RowRef }
  | {
      kind: 'rebase';
      row: RowRef;
      stored: { high: number; low: number };
      asOf: { high: number; low: number } | null;
    }
  | {
      kind: 'skip';
      row: RowRef;
      reason: SkipReason;
      /** The row's range was stale, so the skip is a repair not made. */
      stale: boolean;
    };

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

// ── Pure: reading stored values ─────────────────────────────────────────────

/** A stored DECIMAL as a number; null for NULL, 'bad' for NaN or text. */
function parseStored(raw: string | null): number | null | 'bad' {
  if (raw == null) return null;
  if (raw.trim() === '') return 'bad';
  const value = Number(raw);
  return Number.isFinite(value) ? value : 'bad';
}

const cents = (value: number): number => Math.round(value * 100);

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
 * skip that says why it is not made. The median is checked first: a NULL
 * median is never graded and never written to.
 */
function repairTo(
  row: RangeRow,
  ref: RowRef,
  asOf: { high: number; low: number } | null,
  evidence: Omit<Evidence, 'spx' | 'median' | 'asOf'>,
): RowResult {
  const median = parseStored(row.median_hl_pct);
  if (median === null) return skip(ref, 'null-median', true);
  if (median === 'bad') return skip(ref, 'unreadable-median', true);
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
function storedRange(
  row: RangeRow,
): { high: number; low: number } | SkipReason {
  const high = parseStored(row.opening_range_high);
  const low = parseStored(row.opening_range_low);
  if (high === null && low === null) return 'no-stored-range';
  if (high == null || low == null || high === 'bad' || low === 'bad') {
    return 'unreadable-stored-range';
  }
  return { high, low };
}

// ── Pure: judging a row against its date's candles ──────────────────────────

function judgeWithCandles(
  row: RangeRow,
  candles: readonly SlotCandle[],
): RowResult {
  const slot = parseEntryTimeMinutes(row.entry_time);
  const ref = refOf(row, slot);
  if (Number.isNaN(slot)) return skip(ref, 'no-slot');
  const stored = storedRange(row);
  if (typeof stored === 'string') return skip(ref, stored);

  const state = spxSlotStateAsOf(candles, slot);
  if (state == null) return skip(ref, 'no-as-of-state');
  const asOf = state.openingRange;
  const open = state.runningOHLC.open;
  // With no ended bar the lower bound is the open, as the running range has it.
  const floor = asOf ?? { high: open, low: open };
  const running = spxSlotStateAsOf(candles, slot + BAR_MINUTES)?.openingRange;
  const ceil = {
    high: Math.max(floor.high, running?.high ?? floor.high),
    low: Math.min(floor.low, running?.low ?? floor.low),
  };
  const band: [number, number][] = [
    [floor.high, ceil.high],
    [ceil.low, floor.low],
  ];
  const tol = TOLERANCE_CENTS;
  const stale =
    cents(stored.high) < cents(floor.high) - tol ||
    cents(stored.high) > cents(ceil.high) + tol ||
    cents(stored.low) < cents(ceil.low) - tol ||
    cents(stored.low) > cents(floor.low) + tol;

  if (!stale) {
    const same =
      asOf != null &&
      Math.abs(cents(stored.high) - cents(asOf.high)) <= tol &&
      Math.abs(cents(stored.low) - cents(asOf.low)) <= tol;
    return same
      ? { kind: 'ok', row: ref }
      : { kind: 'rebase', row: ref, stored, asOf };
  }
  return repairTo(row, ref, asOf, {
    source: 'candles',
    bars: barsFor(candles, slot),
    band: {
      high: band[0] as [number, number],
      low: band[1] as [number, number],
    },
  });
}

// ── Pure: a date with no candles ────────────────────────────────────────────

interface OwnRange {
  high: number;
  low: number;
}

/**
 * The range most of a date's rows at or after 10:00 ET hold, when at least two
 * do and no other range has as many; else null.
 */
function ownRangeOf(rows: readonly RangeRow[]): OwnRange | null {
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

function judgeOwnRange(row: RangeRow, own: OwnRange | null): RowResult {
  const slot = parseEntryTimeMinutes(row.entry_time);
  const ref = refOf(row, slot);
  if (Number.isNaN(slot)) return skip(ref, 'no-slot');
  const stored = storedRange(row);
  if (typeof stored === 'string') return skip(ref, stored);

  if (slot < COMPLETE_FROM_CT) {
    // A partial range: with no candles there is nothing to compare it to.
    const differs =
      own != null &&
      (Math.abs(cents(stored.high) - cents(own.high)) > TOLERANCE_CENTS ||
        Math.abs(cents(stored.low) - cents(own.low)) > TOLERANCE_CENTS);
    return differs
      ? skip(ref, 'early-slot-no-candles')
      : { kind: 'ok', row: ref };
  }
  if (own == null) return skip(ref, 'ambiguous-own-range');
  const stale =
    Math.abs(cents(stored.high) - cents(own.high)) > TOLERANCE_CENTS ||
    Math.abs(cents(stored.low) - cents(own.low)) > TOLERANCE_CENTS;
  if (!stale) return { kind: 'ok', row: ref };
  return repairTo(row, ref, own, { source: 'own-range', bars: [], band: null });
}

// ── Pure: the plan for one date ─────────────────────────────────────────────

const sameNumeric = (a: string | null, b: string | null): boolean => {
  if (a == null || b == null) return a == null && b == null;
  return Number(a) === Number(b);
};

/**
 * Whether the date's features row follows the repaired pick row. The pick is
 * the row `build-features` takes (the repair never changes which one: it reads
 * none of these columns).
 */
function featureStatus(
  rows: readonly RangeRow[],
  results: readonly RowResult[],
  feature: FeatureRow | null,
): FeatureStatus {
  const pick = pickFeatureSnapshot(rows);
  if (pick == null) return { kind: 'none' };
  const repaired = results.find((r) => r.row.id === pick.id);
  if (repaired?.kind !== 'repair') return { kind: 'none' };
  if (feature == null) return { kind: 'no-features-row', rowId: pick.id };
  const follows =
    feature.opening_range_signal === repaired.before.signal &&
    sameNumeric(feature.opening_range_pct_consumed, repaired.before.consumed);
  if (!follows) return { kind: 'out-of-sync', rowId: pick.id };
  return {
    kind: 'copy',
    rowId: pick.id,
    before: {
      signal: repaired.before.signal,
      consumed: repaired.before.consumed,
    },
    after: { signal: repaired.after.signal, consumed: repaired.after.consumed },
  };
}

/**
 * Judge every row of one date. `candles` null is a date before Schwab's bars:
 * the date's own range stands in. Rows are judged in id order. Never throws.
 */
export function planDate(input: {
  date: string;
  rows: readonly RangeRow[];
  candles: readonly SlotCandle[] | null;
  feature: FeatureRow | null;
  /** The previous session's close from /api/history; null if it gave none. */
  previousClose: number | null;
}): DatePlan {
  const rows = [...input.rows].sort((a, b) => a.id - b.id);
  const { candles } = input;
  const own = candles == null ? ownRangeOf(rows) : null;
  const results = rows.map((row) =>
    candles == null ? judgeOwnRange(row, own) : judgeWithCandles(row, candles),
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

export interface Summary {
  dates: number;
  datesSkipped: number;
  rows: number;
  repairs: number;
  /** Stale rows: repaired, or left alone for a reason. */
  stale: number;
  rebase: number;
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
    stale: 0,
    rebase: 0,
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
      if (r.kind === 'repair') {
        s.repairs += 1;
        s.stale += 1;
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

/** One row of a backup: what the guarded UPDATE moves. */
export interface MoveRow {
  id: number;
  date: string;
  entryTime: string;
  before: OrValues;
  after: OrValues;
}

export interface MoveFeature {
  date: string;
  before: { signal: string | null; consumed: string | null };
  after: { signal: string | null; consumed: string | null };
}

function repairsOf(plans: readonly DatePlan[]): MoveRow[] {
  return plans.flatMap((p) =>
    p.rows.flatMap((r) =>
      r.kind === 'repair'
        ? [
            {
              id: r.row.id,
              date: r.row.date,
              entryTime: r.row.entryTime,
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
      ? [{ date: p.date, before: p.feature.before, after: p.feature.after }]
      : [],
  );
}

const orColumn = (values: OrValues, column: keyof OrValues): string | null =>
  values[column];

/**
 * Move rows from their `from` values to their `to` values, 500 to a statement,
 * each only where the row still holds `from` in every column the update touches
 * (the text is cast to numeric in SQL and compared with `IS NOT DISTINCT FROM`,
 * so NULL matches NULL). `apply` moves before -> after, `undo` after -> before.
 * Ids that moved are added to `moved` as each statement finishes, so a failure
 * part-way still says how far it got. A statement is not retried: if its answer
 * were lost after a commit, the retry would match nothing and call the rows
 * changed.
 */
async function moveRows(
  sql: Sql,
  rows: readonly MoveRow[],
  direction: 'apply' | 'undo',
  moved: Set<number>,
): Promise<void> {
  const forward = direction === 'apply';
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const chunk = rows.slice(i, i + WRITE_CHUNK);
    const from = (column: keyof OrValues) =>
      chunk.map((r) => orColumn(forward ? r.before : r.after, column));
    const to = (column: keyof OrValues) =>
      chunk.map((r) => orColumn(forward ? r.after : r.before, column));
    const done = (await sql`
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
    `) as Array<{ id: number }>;
    for (const r of done) moved.add(r.id);
  }
}

/** The same move for `training_features`, one row a date, under its guard. */
async function moveFeatures(
  sql: Sql,
  copies: readonly MoveFeature[],
  direction: 'apply' | 'undo',
  moved: Set<string>,
): Promise<void> {
  const forward = direction === 'apply';
  for (let i = 0; i < copies.length; i += WRITE_CHUNK) {
    const chunk = copies.slice(i, i + WRITE_CHUNK);
    const from = (r: MoveFeature) => (forward ? r.before : r.after);
    const to = (r: MoveFeature) => (forward ? r.after : r.before);
    const done = (await sql`
      UPDATE training_features AS t
         SET opening_range_signal = v.to_signal,
             opening_range_pct_consumed = v.to_pct::numeric
        FROM unnest(
               ${chunk.map((r) => r.date)}::date[],
               ${chunk.map((r) => from(r).signal)}::text[],
               ${chunk.map((r) => from(r).consumed)}::text[],
               ${chunk.map((r) => to(r).signal)}::text[],
               ${chunk.map((r) => to(r).consumed)}::text[]
             ) AS v(date, from_signal, from_pct, to_signal, to_pct)
       WHERE t.date = v.date
         AND t.opening_range_signal IS NOT DISTINCT FROM v.from_signal
         AND t.opening_range_pct_consumed IS NOT DISTINCT FROM v.from_pct::numeric
      RETURNING to_char(t.date, 'YYYY-MM-DD') AS day
    `) as Array<{ day: string }>;
    for (const r of done) moved.add(r.day);
  }
}

const NOTE =
  'Backup of the opening-range columns a repair replaced. `--undo-file <this file> --apply` restores them, each only where the row still holds the new values.';

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
const BackupSchema = z.strictObject({
  note: z.string(),
  createdAt: z.string(),
  scope: z.string(),
  rows: z.array(
    z.strictObject({
      id: z.number().int().positive().max(MAX_ID),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      entryTime: z.string(),
      before: OrValuesSchema,
      after: OrValuesSchema,
    }),
  ),
  features: z.array(
    z.strictObject({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      before: FeatureValuesSchema,
      after: FeatureValuesSchema,
    }),
  ),
});

/**
 * The backup, written before the first UPDATE. `wx`: a file already there is
 * never overwritten (it is the only record of an earlier run), and `flush`
 * puts it on disk before the first UPDATE can need it.
 */
function writeBackup(
  dir: string,
  scope: string,
  rows: readonly MoveRow[],
  features: readonly MoveFeature[],
  now: Date,
): string {
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replaceAll(':', '-');
  const file = join(dir, `backup-${scope}-${stamp}.json`);
  try {
    writeFileSync(
      file,
      JSON.stringify({
        note: NOTE,
        createdAt: now.toISOString(),
        scope,
        rows,
        features,
      }),
      { flag: 'wx', flush: true },
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `Refusing to overwrite the backup ${file}. Nothing was written to the database.`,
        { cause: err },
      );
    }
    throw err;
  }
  return file;
}

// ── Run ─────────────────────────────────────────────────────────────────────

export interface RunOptions {
  /** `YYYY-MM-DD`: only this date. */
  date: string | null;
  since: string | null;
  until: string | null;
  apply: boolean;
  /** `--apply` without `--date` must say `--all`. */
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
  applied: ApplyResult | null;
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
 * Read, plan and, with `apply`, write. The dry run reads the database and
 * `/api/history` and writes nothing. A date's history that cannot be read
 * skips that date, named. A refused cookie or a logged-out Schwab ends the run.
 */
export async function runRepair(opts: RunOptions): Promise<RunResult> {
  if (opts.apply && opts.date == null && !opts.all) {
    throw new Error('Refusing to apply without --date <date> or --all.');
  }
  const sql = getDb();
  const dates = await readDates(sql, {
    since: opts.date ?? opts.since,
    until: opts.date ?? opts.until,
  });
  if (dates.length === 0) {
    throw new Error(
      'no market_snapshots rows with an opening range in that range',
    );
  }

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
      access ??= historyAccess(process.env);
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
    const feature = await readFeature(sql, date);
    plans.push(planDate({ date, rows, candles, feature, previousClose }));
  }

  if (!opts.apply) {
    return { apply: false, dates: plans, backupFile: null, applied: null };
  }
  const applied = await applyPlans(sql, plans, opts);
  return {
    apply: true,
    dates: plans,
    backupFile: applied.backupFile,
    applied,
  };
}

/**
 * The backup first, then the rows, then the features rows. Nothing to write
 * writes no backup. A failure part-way leaves the backup, which is the record
 * of what was planned.
 */
async function applyPlans(
  sql: Sql,
  plans: readonly DatePlan[],
  opts: RunOptions,
): Promise<ApplyResult> {
  const rows = repairsOf(plans);
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
  const backupFile = writeBackup(
    opts.backupDir,
    opts.date ?? 'all',
    rows,
    features,
    new Date(),
  );
  const moved = new Set<number>();
  await moveRows(sql, rows, 'apply', moved);
  const featuresMoved = new Set<string>();
  // Only a date whose pick row was actually written.
  const writable = features.filter((f) => {
    const pick = plans.find((p) => p.date === f.date)?.feature;
    return pick?.kind === 'copy' && moved.has(pick.rowId);
  });
  await moveFeatures(sql, writable, 'apply', featuresMoved);
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
}

/**
 * Restore a backup: each row only where it still holds the values the repair
 * wrote. Without `apply` it only counts what the file holds.
 */
export async function runUndo(opts: {
  file: string;
  apply: boolean;
}): Promise<UndoResult> {
  let parsed: z.infer<typeof BackupSchema>;
  try {
    parsed = BackupSchema.parse(JSON.parse(readFileSync(opts.file, 'utf8')));
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`${opts.file} is not a backup this script wrote: ${why}`, {
      cause: err,
    });
  }
  const base = {
    apply: opts.apply,
    rows: parsed.rows.length,
    features: parsed.features.length,
  };
  if (!opts.apply) {
    return { ...base, restored: 0, changedSince: [], featuresRestored: 0 };
  }
  const sql = getDb();
  const moved = new Set<number>();
  await moveRows(sql, parsed.rows, 'undo', moved);
  const featuresMoved = new Set<string>();
  await moveFeatures(sql, parsed.features, 'undo', featuresMoved);
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
    (result.changedSince.length > 0 || result.restored < result.rows)
    ? 1
    : 0;
}

// ── Arguments ───────────────────────────────────────────────────────────────

export interface CliArgs {
  apply: boolean;
  date: string | null;
  all: boolean;
  since: string | null;
  until: string | null;
  undoFile: string | null;
  backupDir: string;
  envFile: string | null;
  help: boolean;
}

export const USAGE = `Usage: npx tsx scripts/repair-stale-opening-range.ts [--date D | --since D --until D]
       npx tsx scripts/repair-stale-opening-range.ts --apply --date D
       npx tsx scripts/repair-stale-opening-range.ts --apply --all
       npx tsx scripts/repair-stale-opening-range.ts --undo-file <backup> [--apply]

Repairs the opening range stored on market_snapshots rows that was stale when
saved: a previous session's range, from a page loaded before the day's first bar
or a tab left open. Every row of every date is checked against its own date's
candles (Schwab's 5-minute $SPX bars, from /api/history; needs APP_URL and
OWNER_SECRET) and a row whose stored high or low is outside [the range as of its
slot, the range with the bar running at its slot] is repaired: all four columns
(high, low, pct consumed and signal, graded by the same function the live page
uses). A row that differs only by the running bar is counted as an as-of rebase
and left alone. A row with a NULL median_hl_pct is not graded: it is listed on
its own and nothing is written to it. Dates before 2026-03-05, which have no
candles, take the date's own range from its other rows at or after 10:00 ET.

The dry run is the default: it reads the database DATABASE_URL points at
(production, in .env.local) and writes nothing. It prints the counts, a per-row
block for every repair with the stored and the new values and the candles used,
the NULL-median list, and the rows whose stored prev_close is not the real
previous session's close (reported only). --apply needs --date D (apply one
date first) or --all; it writes a backup file under ${BACKUP_DIR}/ first (never
overwriting one), then the rows 500 to a statement, each only where it still
holds the values the dry run read.

Options:
  --date <D>         only this date, YYYY-MM-DD
  --since <D>        first date to cover, YYYY-MM-DD
  --until <D>        last date to cover, YYYY-MM-DD (never today or later)
  --apply            write; needs --date or --all
  --all              with --apply, every date in range
  --dry-run          the default, said aloud; contradicts --apply
  --undo-file <f>    restore a backup (with --apply; without it, only counts)
  --backup-dir <d>   where the backup goes (default ${BACKUP_DIR})
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
    date: null,
    all: false,
    since: null,
    until: null,
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
      case '--undo-file':
      case '--backup-dir':
      case '--env-file': {
        if (next == null || next.startsWith('--')) {
          throw new Error(`${flag} needs a value`);
        }
        if (flag === '--undo-file') args.undoFile = next;
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
  if (
    args.date != null &&
    (args.all || args.since != null || args.until != null)
  ) {
    throw new Error('--date cannot be combined with --all, --since or --until');
  }
  if (args.apply && args.undoFile == null && args.date == null && !args.all) {
    throw new Error(
      'Refusing to apply without --date <date> (one date first) or --all',
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
    'the candles give no as-of state (a slot before the open, or a first bar that is not 9:30 ET)',
  'null-median':
    'a stale range with a NULL median_hl_pct: not graded, nothing written',
  'unreadable-median':
    'a stale range with a median that is not a number: not graded, nothing written',
  'no-spot':
    'a stale range whose stored spot is not a usable price: not graded',
  'cannot-grade': 'a stale range the grade function reads as null: not graded',
  'consumed-overflow':
    'a stale range whose consumed value would overflow DECIMAL(6,4)',
  'early-slot-no-candles':
    'a row before 10:00 ET on a date with no candles that differs from the date’s own range',
  'ambiguous-own-range':
    'a date with no candles and no single range most of its rows hold',
};

function barLine(bar: Bar): string {
  const tail = bar.running ? ' (running)' : '';
  return `${bar.start} o${price(bar.open)} h${price(bar.high)} l${price(bar.low)} c${price(bar.close)}${tail}`;
}

/** The per-row block: stored values, new values, and what they came from. */
function repairLines(r: Extract<RowResult, { kind: 'repair' }>): string[] {
  const e = r.evidence;
  const lines = [
    `  ${rowLabel(r.row)}  spx ${e.spx == null ? 'none' : e.spx.toFixed(2)}  median ${e.median == null ? 'none' : e.median.toFixed(4)}`,
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

export function formatReport(result: {
  apply: boolean;
  dates: readonly DatePlan[];
  backupFile: string | null;
}): string {
  const s = summarize(result.dates);
  const out: string[] = [];
  out.push(
    result.apply
      ? 'Stale opening-range repair: APPLY (the rows below were written)'
      : 'Stale opening-range repair: DRY RUN (nothing was written)',
  );
  out.push(
    `Dates read: ${s.dates} (${s.dates - s.datesSkipped} planned, ${s.datesSkipped} skipped). Rows judged: ${s.rows}.`,
  );
  out.push(
    `Stale rows: ${s.stale}. Repairs planned: ${s.repairs}. As-of rebase (inside the band, differs from the as-of range: left alone): ${s.rebase}.`,
  );
  out.push(
    `Repairs by column: opening_range_high ${s.byColumn.high}, opening_range_low ${s.byColumn.low}, opening_range_pct_consumed ${s.byColumn.consumed}, opening_range_signal ${s.byColumn.signal}. training_features copies: ${s.featureCopies}.`,
  );
  const reasons = Object.entries(s.skipsByReason)
    .map(([reason, n]) => `${reason} ${n}`)
    .join(', ');
  out.push(`Rows left alone, by reason: ${reasons || 'none'}.`);

  for (const plan of result.dates) {
    if (plan.source === 'skipped') {
      const detail = plan.detail ? `: ${plan.detail}` : '';
      out.push(`Date skipped: ${plan.date} (${plan.skipped}${detail})`);
    }
  }

  const repairs = result.dates.flatMap((p) =>
    p.rows.filter(
      (r): r is Extract<RowResult, { kind: 'repair' }> => r.kind === 'repair',
    ),
  );
  if (repairs.length > 0) {
    out.push('', 'Repairs (stored -> new, with the candles used):');
    for (const r of repairs) out.push(...repairLines(r));
  }

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

  const others = result.dates.flatMap((p) =>
    p.rows.filter(
      (r): r is Extract<RowResult, { kind: 'skip' }> =>
        r.kind === 'skip' && r.stale && r.reason !== 'null-median',
    ),
  );
  if (others.length > 0) {
    out.push('', `Stale rows left alone (${others.length}):`);
    for (const r of others) {
      out.push(`  ${rowLabel(r.row)}  ${SKIP_TEXT[r.reason]}`);
    }
  }

  const outOfSync = result.dates.filter(
    (p) =>
      p.feature.kind === 'out-of-sync' || p.feature.kind === 'no-features-row',
  );
  if (outOfSync.length > 0) {
    out.push(
      '',
      'Repaired pick rows whose training_features row was not updated:',
    );
    for (const p of outOfSync) {
      out.push(
        `  ${p.date}: ${p.feature.kind === 'out-of-sync' ? 'the features hold other values than the pick row’s old ones' : 'no features row'}`,
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
    `UNDONE: ${result.restored} of ${result.rows} rows restored. Features rows restored: ${result.featuresRestored} of ${result.features}.`,
  ];
  if (result.changedSince.length > 0) {
    out.push(
      `Rows that do not hold the repaired values, so not restored (changed since, or never written): ${result.changedSince.join(', ')}`,
    );
  }
  return out.join('\n');
}
