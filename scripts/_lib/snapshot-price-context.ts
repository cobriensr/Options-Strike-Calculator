/**
 * The one-shot backfill of the SPX price context on `market_snapshots` rows
 * (spec: docs/superpowers/specs/2026-11-17-server-snapshot-builder-design.md,
 * goals G1, G1b and G2; plan: docs/superpowers/plans/
 * 2026-11-17-snapshot-price-context.md, Task 4). Logic for
 * scripts/backfill-snapshot-price-context.ts; it lives here so vitest covers
 * it (scripts/_lib/**).
 *
 * Every row gets what the as-of rule lets it know (`priceContextAsOf`, G2)
 * and the close of the target's prior trading day (G1b):
 * - a row with no usable `spx_open` (NULL, NaN, or not above 0) and a slot at
 *   or after 8:30 CT gets all five columns: `spx_open`, `spx_high`,
 *   `spx_low`, `prev_close` and `overnight_gap`;
 * - a row that has its `spx_open` came from a replay, which took its high and
 *   low through the bar that starts at the slot (a 5-minute peek). It gets
 *   `spx_high` and `spx_low` as of the slot, and `prev_close` and
 *   `overnight_gap`, the gap from its own stored open. Nothing else stored
 *   derives from the high and low, so rewriting them alone leaves the row
 *   consistent. A row whose stored open is not the open as of the slot is
 *   `open-mismatch`, and nothing is written to it. When the candles cannot
 *   give the high and low (bad candles) they are left as stored, and only the
 *   previous close and gap are planned;
 * - a row whose label has no slot ("pre-market"), or whose slot is before
 *   8:30 CT, is left alone.
 * The stored spot (`spx`) keeps its peek: other stored values derive from it.
 * The script covers dates through LAST_REPLAY_DATE only.
 *
 * The candles and the previous close come from the owner's own
 * `/api/history?date=D`, one date at a time with a pause, because the
 * database holds no SPX bars before the 1-minute table starts. A date is
 * skipped whole, and reported by reason, when:
 * - it is not a trading day (checked before any fetch, and not a failure);
 * - its history cannot be read (a failed request, an empty answer, a body
 *   that is not what `/api/history` sends);
 * - it has fewer candles than its session;
 * - it has no previous day that is the target's prior trading day;
 * - that previous close is more than 3.00 from `outcomes.settlement` of the
 *   prior trading day (the G1b acceptance rule: a settlement from a
 *   fetch-outcomes backfill is the official close, up to ~2.55 from the
 *   5-minute close this script plans from, and a wrong-week close misses by
 *   tens of points or more), or gives a gap or a price no column can hold. A
 *   date with no settlement row is planned anyway and listed as not
 *   cross-checked. A planned date more than 0.05 from its settlement is
 *   listed too.
 * Nothing is half-filled, and a skip is never silent. The dry run is meant to
 * predict the apply: no value it plans can overflow its column, and the
 * planner never throws on a value it cannot write.
 *
 * Every column is DECIMAL: the driver returns it as text ("7487.00", "NaN")
 * or null. The plan keeps those raw strings as the `before` values and the
 * apply guard compares them with `IS NOT DISTINCT FROM ...::numeric`, so a
 * stored NaN survives the plan, the undo file and the undo, and is never
 * turned into NULL by a JS number or `JSON.stringify`. Every planned value is
 * rounded to the 2 decimals of its column (half away from zero, as Postgres
 * rounds) before it is compared or written, so a value Postgres stored
 * rounded is never planned again.
 *
 * Dry run is the default. It writes nothing to the database, and leaves a plan
 * file. `--apply --plan F` applies exactly that file: no fetch, no re-plan,
 * no OWNER_SECRET. The file is checked with a strict schema first, and it
 * must have been read from the database DATABASE_URL points at. Then an undo
 * file is written, then the planned rows 500 to a statement, each only where
 * the row still holds the values the plan read (R6, every column the update
 * touches, and for a replayed or close-and-gap row the open its gap came
 * from). A row no statement wrote is read back: one that already holds the
 * plan's values was written by an earlier apply of this plan, and is counted
 * as already applied; any other changed since the dry run, is listed, and
 * makes the exit code 1. `--undo-file F --apply` restores under the reverse
 * guard.
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
  CASH_OPEN_MIN_ET,
  getEarlyCloseHourET,
  isTradingDay,
  parseIsoDate,
  priorTradingDay,
} from '../../src/data/marketHours.js';
import {
  ET_AHEAD_OF_CT_MIN,
  parseEntryTimeMinutes,
} from '../../src/utils/entry-time.js';
import {
  priceContextAsOf,
  type SlotCandle,
} from '../../src/utils/snapshot-slot.js';
import { getETToday } from '../../src/utils/timezone.js';

type Sql = ReturnType<typeof getDb>;

/** Rows per UPDATE (R5). */
export const WRITE_CHUNK = 500;
/** Where the dry-run and undo files go, relative to the working directory. */
export const UNDO_DIR = 'docs/tmp/snapshot-price-context';
/** Pause between history fetches: the endpoint fans out to Schwab. */
export const FETCH_PAUSE_MS = 1000;
/** One history fetch may take this long before it counts as failed. */
const FETCH_TIMEOUT_MS = 60_000;
/** `/api/history` rejects any date before this with a 400. */
const FIRST_HISTORY_DATE = '2000-01-01';
/** The history candle length, minutes. */
const BAR_MINUTES = 5;
/** The 8:30 AM CT open, in minutes after midnight CT (510). */
const FIRST_SLOT_CT = CASH_OPEN_MIN_ET - ET_AHEAD_OF_CT_MIN;
/** DECIMAL(10,2) holds prices below this; DECIMAL(6,2) holds gaps below 1e4. */
const MAX_PRICE = 1e8;
const MAX_GAP_PCT = 1e4;
/**
 * The G1b acceptance rule: a previous close within 3.00 of the settlement
 * (owner decision, 2026-11-20; it was 0.05).
 *
 * `outcomes.settlement` has two writers. The end-of-day main run of
 * `api/cron/fetch-outcomes.ts` stores the last 5-minute bar's close, the same
 * feed as `/api/history`'s `previousDay.close` this script plans from. The
 * fill-only `?backfill=true` run stores Schwab's official daily close, which
 * differs from the 5-minute close by up to about 2.55 points: the 2026-11-19
 * dry run skipped 23 dates at 0.05 with differences of 0.14 to 2.55, each
 * after a day whose outcomes row a backfill wrote. The error G1b guards
 * against, a previous close from the wrong week, misses by tens to hundreds of
 * points (11-06: stored 7720.39, real 7356.73, 363.66 apart). And
 * `previousCloseOf` already requires `previousDay.date` to be the target's
 * prior trading day, which is what guards the session itself.
 */
export const SETTLEMENT_TOLERANCE_CENTS = 300;
/**
 * The dry run lists a planned date whose previous close is more than this
 * (0.05) from the settlement, so a backfilled settlement stays visible.
 */
const SETTLEMENT_REPORT_CENTS = 5;
/** Rows listed in each "and N more" list of the report. */
const LIST_SHOWN = 30;
/**
 * The fetch loop stops after this many dates in a row fail with the same
 * detail (an empty history aside): the endpoint is down, and a date a second
 * costs nothing but time.
 */
const MAX_SAME_FAILURES = 5;
/** Ids read back, 5000 to a query, to tell a row already applied from one changed. */
const READ_CHUNK = 5000;
/** The largest value of the SERIAL id column. */
const MAX_ID = 2_147_483_647;
/**
 * The last date this script covers. From 2026-11-19 the live save carries the
 * quote's real-time open, high and low (Task 2 deploys on 2026-11-18), which
 * must never be overwritten by a value built from candles; the server builder
 * owns those dates.
 */
const LAST_REPLAY_DATE = '2026-11-18';

// ── Types ───────────────────────────────────────────────────────────────────

export type PriceColumn =
  | 'spx_open'
  | 'spx_high'
  | 'spx_low'
  | 'prev_close'
  | 'overnight_gap';

/**
 * Which columns an update writes:
 * - `all`: a row with no usable open, filled from the candles;
 * - `replayed`: a row with its open, which a replay wrote. It gets the high and
 *   low as of its slot (the replay read through the bar that starts at the
 *   slot, a 5-minute peek) and its previous close and gap;
 * - `close-and-gap`: a row with its open whose candles are bad, so its high and
 *   low cannot be known and are left as stored.
 */
export type FillKind = 'all' | 'replayed' | 'close-and-gap';

const COLUMNS_OF: Record<FillKind, readonly PriceColumn[]> = {
  all: ['spx_open', 'spx_high', 'spx_low', 'prev_close', 'overnight_gap'],
  replayed: ['spx_high', 'spx_low', 'prev_close', 'overnight_gap'],
  'close-and-gap': ['prev_close', 'overnight_gap'],
};

/** A DECIMAL column as the driver returns it: text ("7487.00", "NaN") or null. */
export type StoredDecimal = string | null;

export type PriceValues = Record<PriceColumn, StoredDecimal>;

/**
 * A `market_snapshots` row, with the DECIMAL columns as the raw text read. The
 * stored spot (`spx`) and the trust columns are what build-features reads to
 * judge the row (`featureSnapshotRejection`); no plan writes them.
 */
export interface SnapshotRowIn extends PriceValues, SnapshotTrustColumns {
  id: number;
  /** `YYYY-MM-DD` */
  date: string;
  entry_time: string;
  spx: StoredDecimal;
}

/** What `/api/history` gave for one date, reduced to what the plan reads. */
export interface DateHistory {
  /** The target date's regular-session 5-minute SPX bars, start-labelled. */
  candles: readonly SlotCandle[];
  /** The session `/api/history` calls the previous one. */
  previousDay: { date: string; close: number } | null;
}

export type RowSkipReason =
  | 'no-slot'
  | 'before-open'
  | 'bad-candles'
  | 'open-mismatch'
  | 'unchanged';

export type DateSkipReason =
  | 'not-a-trading-day'
  | 'no-history'
  | 'short-candles'
  | 'no-previous-day'
  | 'prev-close-mismatch'
  | 'bad-previous-close';

export type PlanResult =
  | {
      kind: 'update';
      id: number;
      fill: FillKind;
      /** The raw stored text of each column the update writes. */
      before: Partial<PriceValues>;
      /** The planned 2-decimal text of each of them. */
      after: Partial<Record<PriceColumn, string>>;
      /**
       * A replayed or close-and-gap update only: the stored `spx_open` the gap
       * was computed from. It is written by no one, and guards the write: a row
       * whose open changed since the plan has a gap, and as-of high and low,
       * that no longer follow from it.
       */
      guardOpen?: string;
    }
  | {
      kind: 'skip';
      id: number;
      reason: RowSkipReason;
      /** `open-mismatch`: the stored open and the open as of the slot. */
      detail?: string;
      /**
       * `unchanged` on a row with its open whose candles are bad: its previous
       * close and gap are right, and its high and low were not looked at.
       */
      highLowLeft?: boolean;
    };

type PlannedUpdate = Extract<PlanResult, { kind: 'update' }>;

// ── Rounding ────────────────────────────────────────────────────────────────

/**
 * `value` at 2 decimals as text, half away from zero: what Postgres numeric
 * stores for the number's shortest decimal text (which is what the driver
 * sends). Done on that text, not with `Math.round` (which rounds a negative
 * half toward +infinity) or `toFixed` (which rounds the binary value, so 2.675
 * gives 2.67 where Postgres gives 2.68). No negative zero: numeric has none.
 * Throws on a value that is not finite or past 1e21, which no column holds.
 */
export function toDecimal2(value: number): string {
  const abs = Math.abs(value);
  if (!Number.isFinite(value) || abs >= 1e21) {
    throw new RangeError(`${value} cannot be written to a DECIMAL column`);
  }
  const text = abs.toString();
  // Below 1e-6 the text is exponent form; it is under half a cent anyway.
  if (text.includes('e')) return '0.00';
  const [whole = '0', fraction = ''] = text.split('.');
  const cents =
    BigInt(whole + fraction.padEnd(2, '0').slice(0, 2)) +
    ((fraction[2] ?? '0') >= '5' ? 1n : 0n);
  const digits = cents.toString().padStart(3, '0');
  const body = `${digits.slice(0, -2)}.${digits.slice(-2)}`;
  return value < 0 && cents !== 0n ? `-${body}` : body;
}

/** A stored DECIMAL as a number; null for NULL, NaN, or anything not finite. */
function storedNumber(raw: StoredDecimal): number | null {
  if (raw == null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** A stored price: finite and above 0. A stored 0 is a missing open. */
function storedPrice(raw: StoredDecimal): number | null {
  const value = storedNumber(raw);
  return value != null && value > 0 ? value : null;
}

/** The stored text and the planned 2-decimal text are the same number. */
function sameDecimal(stored: StoredDecimal, planned: string): boolean {
  const value = storedNumber(stored);
  return value != null && value === Number(planned);
}

/**
 * `value` as 2-decimal text for a column that holds absolute values below
 * `limit`, or null when it is not finite, is past what `toDecimal2` takes, or
 * rounds to a value the column cannot hold. The planner writes only what this
 * returns, so no planned value can overflow its column or throw out of the
 * planner.
 */
function fitDecimal(value: number, limit: number): string | null {
  if (!Number.isFinite(value) || Math.abs(value) >= 1e21) return null;
  const text = toDecimal2(value);
  return Math.abs(Number(text)) < limit ? text : null;
}

/** A price that fits DECIMAL(10,2) and does not round to 0.00. */
function fitPrice(value: number): string | null {
  const text = fitDecimal(value, MAX_PRICE);
  return text != null && Number(text) > 0 ? text : null;
}

// ── Plan (pure) ─────────────────────────────────────────────────────────────

/** `((open - prevClose) / prevClose) * 100`, as the page computes it. */
const gapPct = (open: number, prevClose: number): number =>
  ((open - prevClose) / prevClose) * 100;

/** A full day has 78 bars; an early-close day has (close hour - 9.5) * 12. */
function expectedCandles(date: string): number {
  const closeHourET = getEarlyCloseHourET(date) ?? 16;
  return (closeHourET * 60 - CASH_OPEN_MIN_ET) / BAR_MINUTES;
}

/**
 * The close of the target's prior trading day, or null when `/api/history`
 * did not report that session: a Schwab window with a hole holds an older
 * session, whose close would pass as yesterday's (the wrong-week bug).
 */
export function previousCloseOf(
  date: string,
  previousDay: DateHistory['previousDay'],
): number | null {
  if (previousDay == null || previousDay.date !== priorTradingDay(date)) {
    return null;
  }
  const { close } = previousDay;
  return Number.isFinite(close) && close > 0 ? close : null;
}

function updateOf(
  row: SnapshotRowIn,
  fill: FillKind,
  after: Partial<Record<PriceColumn, string>>,
  guardOpen: string | null = null,
): PlanResult {
  const planned = Object.entries(after) as Array<[PriceColumn, string]>;
  if (planned.every(([column, text]) => sameDecimal(row[column], text))) {
    return { kind: 'skip', id: row.id, reason: 'unchanged' };
  }
  const before: Partial<PriceValues> = {};
  for (const [column] of planned) before[column] = row[column];
  return {
    kind: 'update',
    id: row.id,
    fill,
    before,
    after,
    ...(guardOpen == null ? {} : { guardOpen }),
  };
}

/**
 * How far the previous close is from `outcomes.settlement`, in whole cents.
 * Rounded, never compared as a float: 7000.05 - 7000 is 0.05000000000018.
 */
function settlementCents(previousClose: number, settlement: number): number {
  return Math.round(Math.abs(previousClose - settlement) * 100);
}

/**
 * The previous close and `outcomes.settlement` agree to 3.00, in whole cents.
 * Wide enough for a settlement that is the official close (a fetch-outcomes
 * backfill) against a previous close that is the last 5-minute bar's close.
 */
function withinSettlement(previousClose: number, settlement: number): boolean {
  return (
    settlementCents(previousClose, settlement) <= SETTLEMENT_TOLERANCE_CENTS
  );
}

/**
 * The previous close that goes to the writer: its text, and its value for the
 * gap. Fixed once per date, after the date-level checks.
 */
interface PreviousClose {
  value: number;
  text: string;
}

/**
 * A row that cannot be planned because a price it needs cannot be held: a
 * candle, or its own stored open, is past what a column takes.
 */
const badCandles = (id: number): PlanResult => ({
  kind: 'skip',
  id,
  reason: 'bad-candles',
});

/**
 * A row that has its open came from a replay (through 2026-11-18 a live row's
 * open is NULL, and an upsert never lets a backtest write replace a live row).
 * The replay took its high and low through the bar that starts at the slot, a
 * 5-minute peek, so they are rewritten to the values as of the slot, with the
 * previous close and the gap from the row's own open. Nothing else stored
 * derives from `spx_high` and `spx_low`, so rewriting them alone leaves the
 * row consistent.
 * - A stored open that is not the open as of the slot (at 2 decimals) is
 *   `open-mismatch`: the row is not one this replay would rebuild, and nothing
 *   is written to it.
 * - Candles that cannot give the high and low (a bad bar, a value no column
 *   holds) leave them as stored: only the previous close and gap are planned,
 *   as the narrower `close-and-gap` kind, which the report names.
 */
function planReplayed(
  row: SnapshotRowIn,
  ownOpen: number,
  candles: readonly SlotCandle[],
  slot: number,
  prev: PreviousClose,
): PlanResult {
  // A stored open past the column's range gives a gap no column holds.
  const gap = fitDecimal(gapPct(ownOpen, prev.value), MAX_GAP_PCT);
  if (gap == null) return badCandles(row.id);
  const context = priceContextAsOf(candles, slot);
  const open = context == null ? null : fitPrice(context.open);
  const high = context == null ? null : fitPrice(context.high);
  const low = context == null ? null : fitPrice(context.low);
  if (open == null || high == null || low == null) {
    const narrower = updateOf(
      row,
      'close-and-gap',
      { prev_close: prev.text, overnight_gap: gap },
      row.spx_open,
    );
    return narrower.kind === 'skip'
      ? { ...narrower, highLowLeft: true }
      : narrower;
  }
  if (!sameDecimal(row.spx_open, open)) {
    return {
      kind: 'skip',
      id: row.id,
      reason: 'open-mismatch',
      detail: `stored ${row.spx_open ?? 'NULL'}, as of the slot ${open}`,
    };
  }
  return updateOf(
    row,
    'replayed',
    {
      spx_high: high,
      spx_low: low,
      prev_close: prev.text,
      overnight_gap: gap,
    },
    row.spx_open,
  );
}

function planRow(
  row: SnapshotRowIn,
  candles: readonly SlotCandle[],
  prev: PreviousClose,
): PlanResult {
  const slot = parseEntryTimeMinutes(row.entry_time);
  if (!Number.isFinite(slot)) {
    return { kind: 'skip', id: row.id, reason: 'no-slot' };
  }
  if (slot < FIRST_SLOT_CT) {
    return { kind: 'skip', id: row.id, reason: 'before-open' };
  }

  const ownOpen = storedPrice(row.spx_open);
  if (ownOpen != null) return planReplayed(row, ownOpen, candles, slot, prev);

  // A finite slot at or after the open that yields nothing is a data fault in
  // the candles: priceContextAsOf's other nulls are ruled out above.
  const context = priceContextAsOf(candles, slot);
  if (context == null) return badCandles(row.id);
  const open = fitPrice(context.open);
  const high = fitPrice(context.high);
  const low = fitPrice(context.low);
  const gap = fitDecimal(gapPct(context.open, prev.value), MAX_GAP_PCT);
  if (open == null || high == null || low == null || gap == null) {
    return badCandles(row.id);
  }
  return updateOf(row, 'all', {
    spx_open: open,
    spx_high: high,
    spx_low: low,
    prev_close: prev.text,
    overnight_gap: gap,
  });
}

/**
 * A previous close that gives, against the session's own open, a gap
 * DECIMAL(6,2) cannot hold. The open is the first candle's; when it is not a
 * price a column holds, the rows report it and the date is not blamed on the
 * previous close.
 */
function gapFits(
  previousClose: number,
  candles: readonly SlotCandle[],
): boolean {
  const open = candles[0]?.open;
  if (open == null || fitPrice(open) == null) return true;
  return fitDecimal(gapPct(open, previousClose), MAX_GAP_PCT) != null;
}

/**
 * Plan one date's rows. A date with no history, with fewer candles than its
 * session holds, with no usable previous day, whose previous close is more
 * than 3.00 from `settlement` (`outcomes.settlement` of the prior trading
 * day, null when there is none; 3.00 so a settlement that is the official
 * close, from a fetch-outcomes backfill, passes against the 5-minute close),
 * or whose previous close no column can hold,
 * is skipped whole (`skippedDate`, and no row results). Otherwise each row is
 * planned alone, in input order. `previousClose` is the close the history
 * gave, once it is a valid one, whether or not the date went on.
 */
export function planDate(
  date: string,
  rows: readonly SnapshotRowIn[],
  history: DateHistory | null,
  settlement: number | null,
): {
  results: PlanResult[];
  skippedDate?: DateSkipReason;
  previousClose?: number;
} {
  // First, and before any fetch: a weekend or a closure has no session.
  if (!isTradingDay(date)) {
    return { results: [], skippedDate: 'not-a-trading-day' };
  }
  if (history == null) return { results: [], skippedDate: 'no-history' };
  if (history.candles.length < expectedCandles(date)) {
    return { results: [], skippedDate: 'short-candles' };
  }
  const previousClose = previousCloseOf(date, history.previousDay);
  if (previousClose == null)
    return { results: [], skippedDate: 'no-previous-day' };
  if (
    settlement != null &&
    Number.isFinite(settlement) &&
    !withinSettlement(previousClose, settlement)
  ) {
    return { results: [], skippedDate: 'prev-close-mismatch', previousClose };
  }
  const text = fitPrice(previousClose);
  if (text == null || !gapFits(previousClose, history.candles)) {
    return { results: [], skippedDate: 'bad-previous-close', previousClose };
  }
  const prev = { value: previousClose, text };
  return {
    results: rows.map((row) => planRow(row, history.candles, prev)),
    previousClose,
  };
}

/**
 * The row `build-features` would pick for the date (`pickFeatureSnapshot`,
 * rows in id order, the same columns it reads: `entry_time`, `spx_open`, the
 * range and the trust columns) before the planned updates and after them. The
 * "after" pick reads the planned `spx_open`, `spx_high` and `spx_low`, which
 * can turn a row with no range into a trusted one, and the stored `spx` and
 * trust columns, which no plan changes. A side is null when the date has no
 * trusted row. Returns null when the pick does not change; the owner rebuilds
 * `training_features` only for the dates that report a change.
 */
export function featurePickChange(
  rows: readonly SnapshotRowIn[],
  results: readonly PlanResult[],
): { from: number | null; to: number | null } | null {
  const planned = new Map<number, PlannedUpdate['after']>();
  for (const result of results) {
    if (result.kind === 'update') planned.set(result.id, result.after);
  }
  const ordered = [...rows].sort((a, b) => a.id - b.id);
  const pick = (afterPlan: boolean) =>
    pickFeatureSnapshot(
      ordered.map((row) => {
        const after = afterPlan ? planned.get(row.id) : undefined;
        return {
          ...row,
          spx_open: after?.spx_open ?? row.spx_open,
          spx_high: after?.spx_high ?? row.spx_high,
          spx_low: after?.spx_low ?? row.spx_low,
        };
      }),
    )?.id ?? null;
  const from = pick(false);
  const to = pick(true);
  return from === to ? null : { from, to };
}

// ── Reading /api/history ────────────────────────────────────────────────────

export type HistoryFetch =
  | { kind: 'ok'; history: DateHistory }
  /** The auth was refused: every date would fail the same way. */
  | { kind: 'denied'; status: number }
  /** The Schwab login lapsed: every date would fail the same way. */
  | { kind: 'logged-out'; status: number }
  | { kind: 'failed'; detail: string };

/**
 * An empty answer is a failure: the endpoint answers 200 with no candles for a
 * date older than Schwab's 5-minute window. A deployed endpoint answers a
 * failed Schwab fetch with a 502 or a 503 instead (see `statusDetail`), but
 * one that predates that answered it with a 200 and no candles too, and the
 * two cannot be told apart from here, so the detail names both.
 */
const EMPTY_HISTORY =
  "empty history: a Schwab failure, or a date older than Schwab's 5-minute window";

/** The `code` /api/history answers a logged-out Schwab with, on a 503. */
const LOGGED_OUT_CODE = 'schwab_logged_out';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The `code` of a non-200 /api/history body, when it is a short snake-case
 * token and so safe to print; null for anything else, a body that is not JSON
 * included. The body is a response, not something this script wrote.
 */
function errorCodeOf(text: string): string | null {
  try {
    const body: unknown = JSON.parse(text);
    if (!isRecord(body)) return null;
    const { code } = body;
    return typeof code === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(code)
      ? code
      : null;
  } catch {
    return null;
  }
}

/** `HTTP 502 (schwab_fetch_failed)`: the status, and the code the body names. */
function statusDetail(status: number, code: string | null): string {
  return code == null ? `HTTP ${status}` : `HTTP ${status} (${code})`;
}

/** `next` starts after `earlier`. False when either is NaN. */
const startsAfter = (next: number, earlier: number): boolean => next > earlier;

/** A JSON number as is; anything else as NaN, which the as-of rule rejects. */
const numberOrNaN = (value: unknown): number =>
  typeof value === 'number' ? value : Number.NaN;

/**
 * Reduce one `/api/history` answer to what the plan reads. A 401 or 403 is
 * `denied` and a 503 whose body has `code: 'schwab_logged_out'` is
 * `logged-out`: both end the run, as every later date would fail the same way.
 * Any other non-200 is `failed` for that date, with the status and the
 * body's `code` when it has a short one (`HTTP 502 (schwab_fetch_failed)`). A
 * body that is not JSON, one with no `spx`, one echoing another date, and
 * candles that are not an array of objects are `failed`, each named, and so is
 * a 200 with no candles (EMPTY_HISTORY) and candles whose `datetime`s do not
 * strictly ascend: `/api/history` sorts and dedupes them, so a repeat or an
 * order fault means that regressed, and a high or low read from it could be
 * silently wrong. A candle price field that is not a number becomes NaN, so
 * the rows that need that bar are reported as bad-candles.
 */
export function readHistoryResponse(
  date: string,
  status: number,
  text: string,
): HistoryFetch {
  if (status === 401 || status === 403) return { kind: 'denied', status };
  if (status !== 200) {
    const code = errorCodeOf(text);
    return status === 503 && code === LOGGED_OUT_CODE
      ? { kind: 'logged-out', status }
      : { kind: 'failed', detail: statusDetail(status, code) };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { kind: 'failed', detail: 'HTTP 200 but the body is not JSON' };
  }
  if (!isRecord(body) || !isRecord(body.spx)) {
    return { kind: 'failed', detail: 'the response has no spx' };
  }
  if (body.date !== date) {
    const echoed = typeof body.date === 'string' ? body.date : '(none)';
    return {
      kind: 'failed',
      detail: `the response is for ${echoed}, not ${date}`,
    };
  }
  const { candles: raw, previousDay: rawPrevious } = body.spx;
  if (!Array.isArray(raw)) {
    return { kind: 'failed', detail: 'spx.candles is not an array' };
  }
  if (raw.length === 0) return { kind: 'failed', detail: EMPTY_HISTORY };
  const candles: SlotCandle[] = [];
  for (const [index, item] of raw.entries()) {
    if (!isRecord(item)) {
      return { kind: 'failed', detail: `candle ${index} is not an object` };
    }
    const candle = {
      datetime: numberOrNaN(item.datetime),
      open: numberOrNaN(item.open),
      high: numberOrNaN(item.high),
      low: numberOrNaN(item.low),
      close: numberOrNaN(item.close),
    };
    const earlier = candles.at(-1);
    if (earlier != null && !startsAfter(candle.datetime, earlier.datetime)) {
      return {
        kind: 'failed',
        detail: `candle ${index} does not start after candle ${index - 1}: datetimes must be strictly ascending`,
      };
    }
    candles.push(candle);
  }
  const previousDay = isRecord(rawPrevious)
    ? {
        date: typeof rawPrevious.date === 'string' ? rawPrevious.date : '',
        close: numberOrNaN(rawPrevious.close),
      }
    : null;
  return { kind: 'ok', history: { candles, previousDay } };
}

/** Where to fetch history from, and the owner cookie value. Never printed. */
export interface HistoryAccess {
  origin: string;
  secret: string;
}

/**
 * The origin from APP_URL and the owner cookie value from OWNER_SECRET. The
 * messages name the variables, never a value. The cookie goes over https, or
 * to a local dev server over http, and nowhere else.
 */
export function historyAccess(
  env: Readonly<Record<string, string | undefined>>,
): HistoryAccess {
  const secret = env.OWNER_SECRET?.trim();
  if (!secret) {
    throw new Error(
      'Refusing to run. OWNER_SECRET is not set: /api/history needs the owner cookie.',
    );
  }
  const appUrl = env.APP_URL?.trim();
  if (!appUrl) {
    throw new Error(
      'Refusing to run. APP_URL is not set: it is the origin to fetch history from.',
    );
  }
  let url: URL;
  try {
    url = new URL(appUrl);
  } catch {
    throw new Error('Refusing to run. APP_URL is not a URL.');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error(
      'Refusing to run. APP_URL must be https (or http on localhost): the owner cookie goes with every request.',
    );
  }
  return { origin: url.origin, secret };
}

/**
 * The host the owner cookie is about to go to, for the CLI to print before the
 * first fetch. Refuses what the run refuses, and never returns the cookie.
 */
export function historyOrigin(
  env: Readonly<Record<string, string | undefined>>,
): string {
  return new URL(historyAccess(env).origin).hostname;
}

/** The message of an error and of its cause, where the runtime has one. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? ` (${err.cause.message})` : '';
  return `${err.message}${cause}`;
}

export async function fetchHistory(
  access: HistoryAccess,
  date: string,
): Promise<HistoryFetch> {
  const redact = (text: string): string =>
    text.replaceAll(access.secret, '[redacted]');
  let response: Response;
  let text: string;
  try {
    // A redirect is an error, never followed: the cookie is for this origin.
    response = await fetch(`${access.origin}/api/history?date=${date}`, {
      headers: { cookie: `sc-owner=${access.secret}; sc-hint=1` },
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    text = await response.text();
  } catch (err) {
    return {
      kind: 'failed',
      detail: redact(`request failed: ${describeError(err)}`),
    };
  }
  return readHistoryResponse(date, response.status, text);
}

// ── Arguments ───────────────────────────────────────────────────────────────

export interface CliArgs {
  apply: boolean;
  /** `YYYY-MM-DD`: the first date to cover (default: every date). */
  since: string | null;
  /** `YYYY-MM-DD`: the last date to cover (default: today ET). */
  until: string | null;
  undoFile: string | null;
  /** The dry-run file to apply (or, without --apply, to count). */
  planFile: string | null;
  envFile: string | null;
  help: boolean;
}

export const USAGE = `Usage: npx tsx scripts/backfill-snapshot-price-context.ts [--since D] [--until D]
       npx tsx scripts/backfill-snapshot-price-context.ts --apply --plan <dry-run file>
       npx tsx scripts/backfill-snapshot-price-context.ts --undo-file <file> [--apply]

Fills the SPX open, high, low, previous close and overnight gap on
market_snapshots rows, from the owner's /api/history (needs OWNER_SECRET and
APP_URL in the environment or .env.local). A row with no stored open gets all
five, as the as-of rule lets its slot know them; a row with an open (a replay
wrote it) gets its high and low as of the slot, which removes the 5-minute
peek, and its previous close and gap; one whose open is not the open as of its
slot is skipped as open-mismatch. The previous close is the close of the target's
prior trading day, and must be within 3.00 of that day's outcomes.settlement (a
settlement a fetch-outcomes backfill wrote is the official close, which can
differ from this 5-minute close by a point or two; the report lists the planned
dates more than 0.05 off). A date with no settlement row is planned and listed
as not cross-checked. A date whose history cannot be read or is empty, is short
of candles, or has no usable previous close is skipped whole and reported.

Two steps. First a dry run, the default: it reads every snapshot date in the
range, fetches /api/history once per date with a pause (run it outside
13:00-23:00 UTC on a weekday), prints the counts, the skips by reason, how
many values are fills and how many overwrites, two sample rows per kind and
the dates whose training_features pick changes, and writes a plan file under
${UNDO_DIR}/. It writes nothing to the database. A date that is not a trading
day is skipped before any fetch. Exit 1 if any date's history failed or came
back empty, or if 5 dates in a row failed the same way (the loop stops, and
the report counts the dates it never tried). Then, after the report is read,
--apply --plan applies exactly that file: no fetch, no re-plan, no
OWNER_SECRET, and only on the database the dry run read (the plan records its
host). A row an earlier apply of the same plan already wrote is counted as
already applied. It exits 1 if a planned row was neither written nor already
applied.

Options:
  --since <date>      first date to cover, YYYY-MM-DD (default: the earliest)
  --until <date>      last date to cover, YYYY-MM-DD (default: today ET, and never
                      after ${LAST_REPLAY_DATE}: from the next day a live row
                      carries the quote's real-time open, high and low, which
                      this script must not overwrite; later dates are refused)
  --plan <file>       the plan file of a dry run. With --apply it is applied:
                      the file is checked first, an undo file and then an
                      apply report are written under ${UNDO_DIR}/, and the
                      rows are written 500 to a statement, each only where it
                      still holds the values the dry run read. Without
                      --apply the plan is only counted
  --apply             write. Needs --plan or --undo-file
  --dry-run           the default, said aloud; contradicts --apply
  --undo-file <file>  restore the values an earlier --apply replaced (with
                      --apply; without it, only counts the file's rows)
  --env-file <path>   .env.local to load (default: the nearest one up the tree)
  --help, -h          print this and exit`;

/** `--apply` is the only way to write; `--dry-run` just says the default aloud. */
export function parseArgs(argv: readonly string[]): CliArgs {
  let apply = false;
  let dryRun = false;
  let help = false;
  let since: string | null = null;
  let until: string | null = null;
  let undoFile: string | null = null;
  let planFile: string | null = null;
  let envFile: string | null = null;
  const valueOf = (flag: string, i: number): string => {
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) {
      throw new Error(`${flag} needs a value`);
    }
    return value;
  };
  const dateOf = (flag: string, i: number): string => {
    const value = valueOf(flag, i);
    if (parseIsoDate(value) == null) {
      throw new Error(`${flag} ${value} is not a YYYY-MM-DD date`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    if (flag === '--apply') apply = true;
    else if (flag === '--dry-run') dryRun = true;
    else if (flag === '--help' || flag === '-h') help = true;
    else if (flag === '--since') {
      since = dateOf(flag, i);
      i += 1;
    } else if (flag === '--until') {
      until = dateOf(flag, i);
      i += 1;
    } else if (flag === '--undo-file') {
      undoFile = valueOf(flag, i);
      i += 1;
    } else if (flag === '--plan') {
      planFile = valueOf(flag, i);
      i += 1;
    } else if (flag === '--env-file') {
      envFile = valueOf(flag, i);
      i += 1;
    } else throw new Error(`unknown argument ${flag}`);
  }
  if (apply && dryRun) throw new Error('--apply and --dry-run contradict');
  if (planFile != null && undoFile != null) {
    throw new Error('--plan and --undo-file contradict');
  }
  if (since != null || until != null) {
    if (undoFile != null) {
      throw new Error('--undo-file contradicts --since and --until');
    }
    if (planFile != null) {
      throw new Error('--plan contradicts --since and --until');
    }
  }
  if (apply && planFile == null && undoFile == null) {
    throw new Error(
      '--apply needs --plan <dry-run file> or --undo-file <file>: apply the plan a dry run wrote',
    );
  }
  for (const [flag, value] of [
    ['--since', since],
    ['--until', until],
  ] as const) {
    if (value != null && value > LAST_REPLAY_DATE) {
      throw new Error(cutoffMessage(flag, value));
    }
  }
  if (since != null && until != null && since > until) {
    throw new Error(`--since ${since} is after --until ${until}`);
  }
  return { apply, since, until, undoFile, planFile, envFile, help };
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** Every date with a snapshot row in the range, ascending. */
async function readDates(
  sql: Sql,
  since: string,
  until: string,
): Promise<string[]> {
  const rows = (await withDbRetry(
    () => sql`
      SELECT DISTINCT to_char(date, 'YYYY-MM-DD') AS day
        FROM market_snapshots
       WHERE date >= ${since}::date
         AND date <= ${until}::date
       ORDER BY day
    `,
  )) as Array<{ day: string }>;
  return rows.map((r) => r.day);
}

/**
 * One date's rows, in id order. DECIMAL columns are read as text. The trust
 * columns are the SQL text build-features reads (SNAPSHOT_TRUST_COLUMNS_SQL),
 * which is a constant, so it goes into the text of a `sql.query` call; the date
 * is the one bound value.
 */
async function readRows(sql: Sql, date: string): Promise<SnapshotRowIn[]> {
  const rows = (await withDbRetry(() =>
    sql.query(
      `SELECT id, to_char(date, 'YYYY-MM-DD') AS date, entry_time,
              spx::text AS spx, spx_open::text AS spx_open,
              spx_high::text AS spx_high, spx_low::text AS spx_low,
              prev_close::text AS prev_close,
              overnight_gap::text AS overnight_gap,
              ${SNAPSHOT_TRUST_COLUMNS_SQL}
         FROM market_snapshots
        WHERE date = $1::date
        ORDER BY id`,
      [date],
    ),
  )) as SnapshotRowIn[];
  return rows;
}

/**
 * `outcomes.settlement` of each prior trading day of `days`, in one read-only
 * query, keyed by the prior day. A day with no row, or a settlement that is
 * NULL, NaN or not above 0, is absent: its date is planned and listed as not
 * cross-checked.
 */
async function readSettlements(
  sql: Sql,
  days: readonly string[],
): Promise<Map<string, number>> {
  const priors = [...new Set(days.map((d) => priorTradingDay(d)))];
  const rows = (await withDbRetry(
    () => sql`
      SELECT to_char(date, 'YYYY-MM-DD') AS day, settlement::text AS settlement
        FROM outcomes
       WHERE date = ANY(${priors}::date[])
    `,
  )) as Array<{ day: string; settlement: string | null }>;
  const settlements = new Map<string, number>();
  for (const row of rows) {
    const value = storedPrice(row.settlement);
    if (value != null) settlements.set(row.day, value);
  }
  return settlements;
}

// ── Writes ──────────────────────────────────────────────────────────────────

/** What an undo file holds per row, and what the guarded UPDATE moves. */
export interface UndoRow {
  id: number;
  date: string;
  entryTime: string;
  fill: FillKind;
  before: Partial<PriceValues>;
  after: Partial<Record<PriceColumn, string>>;
  /** A replayed or close-and-gap row: the open its gap came from, a guard. */
  guardOpen?: string;
}

/**
 * The text of each column as Postgres prints it, which the schema holds the
 * plan to: a price is DECIMAL(10,2), up to 8 whole digits and 2 decimals, and
 * the gap is DECIMAL(6,2), up to 4 and 2. `before` may also be NaN, which a
 * DECIMAL holds; an `after` never is.
 */
const PRICE_TEXT = /^-?\d{1,8}\.\d{2}$/;
const GAP_TEXT = /^-?\d{1,4}\.\d{2}$/;
const priceBefore = z.union([z.literal('NaN'), z.string().regex(PRICE_TEXT)]);
const gapBefore = z.union([z.literal('NaN'), z.string().regex(GAP_TEXT)]);
const priceAfter = z.string().regex(PRICE_TEXT);
const gapAfter = z.string().regex(GAP_TEXT);
/** A stored open, which is above 0 by the time it guards a row. */
const guardOpenText = z.string().regex(/^\d{1,8}\.\d{2}$/);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const rowHead = (date: z.ZodString) => ({
  id: z.number().int().positive().max(MAX_ID),
  date,
  entryTime: z.string(),
});
/**
 * One row of a plan or an undo file, strict per fill kind. The two files use
 * it with different dates: a plan's must be real ones (see PlanFileSchema),
 * an undo's may be any text.
 */
const rowSchema = (date: z.ZodString) =>
  z.discriminatedUnion('fill', [
    z.strictObject({
      ...rowHead(date),
      fill: z.literal('all'),
      before: z.strictObject({
        spx_open: priceBefore.nullable(),
        spx_high: priceBefore.nullable(),
        spx_low: priceBefore.nullable(),
        prev_close: priceBefore.nullable(),
        overnight_gap: gapBefore.nullable(),
      }),
      after: z.strictObject({
        spx_open: priceAfter,
        spx_high: priceAfter,
        spx_low: priceAfter,
        prev_close: priceAfter,
        overnight_gap: gapAfter,
      }),
    }),
    z.strictObject({
      ...rowHead(date),
      fill: z.literal('replayed'),
      before: z.strictObject({
        spx_high: priceBefore.nullable(),
        spx_low: priceBefore.nullable(),
        prev_close: priceBefore.nullable(),
        overnight_gap: gapBefore.nullable(),
      }),
      after: z.strictObject({
        spx_high: priceAfter,
        spx_low: priceAfter,
        prev_close: priceAfter,
        overnight_gap: gapAfter,
      }),
      guardOpen: guardOpenText,
    }),
    z.strictObject({
      ...rowHead(date),
      fill: z.literal('close-and-gap'),
      before: z.strictObject({
        prev_close: priceBefore.nullable(),
        overnight_gap: gapBefore.nullable(),
      }),
      after: z.strictObject({
        prev_close: priceAfter,
        overnight_gap: gapAfter,
      }),
      guardOpen: guardOpenText,
    }),
  ]);

/** One row id twice would be moved twice, and counted once. */
const uniqueIds = (rows: ReadonlyArray<{ id: number }>): boolean =>
  new Set(rows.map((r) => r.id)).size === rows.length;
const rowsSchema = (date: z.ZodString) =>
  z
    .array(rowSchema(date))
    .refine(uniqueIds, { message: 'a row id appears twice' });
/**
 * An undo file accepts a row of any date: it restores only what an apply of
 * this script wrote, and an apply refuses a plan past the cutoff, so a row
 * dated after it cannot have been written by one. Checking the date here would
 * only stop an undo.
 */
const UndoFileSchema = z.strictObject({
  note: z.string(),
  createdAt: z.string(),
  rows: rowsSchema(z.string()),
});

/** Why a date after LAST_REPLAY_DATE is refused, in a message. */
const CUTOFF_REASON =
  "from the next day a live row carries the quote's real-time open, high and low, which a value built from candles must never overwrite";
const CUTOFF_TAIL = `${LAST_REPLAY_DATE}, the last date this script covers: ${CUTOFF_REASON}`;
const cutoffMessage = (what: string, date: string): string =>
  `${what} ${date} is after ${CUTOFF_TAIL}`;

/**
 * The plan file a dry run leaves, and `--apply --plan` applies. Strict: an
 * unknown key, a value that is not a decimal of its column's shape, columns
 * that do not fit the fill kind or a repeated row id is refused before any
 * write. A plan is also refused when any update's date, or `until`, is after
 * LAST_REPLAY_DATE: a dry run never plans such a row, so an old or hand-edited
 * file that does would rewrite a live row, whose real-time open, high and low
 * every other guard would let through (they match on the id and the values).
 * `updates` is the whole of what an apply reads; `dbHost` is the database the
 * plan was read from, and an apply refuses another; `report` is for people and
 * is not read.
 */
const PlanFileSchema = z
  .strictObject({
    note: z.string(),
    createdAt: z.string(),
    dbHost: z.string().min(1),
    since: IsoDate.nullable(),
    until: IsoDate,
    summary: z.string(),
    updates: rowsSchema(IsoDate),
    report: z.record(z.string(), z.unknown()),
  })
  .superRefine((plan, ctx) => {
    plan.updates.forEach((update, index) => {
      if (update.date > LAST_REPLAY_DATE) {
        ctx.addIssue({
          code: 'custom',
          path: ['updates', index, 'date'],
          message: `of row ${update.id} is ${update.date}, which is after ${CUTOFF_TAIL}`,
        });
      }
    });
    for (const [key, value] of [
      ['since', plan.since],
      ['until', plan.until],
    ] as const) {
      if (value != null && value > LAST_REPLAY_DATE) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `is ${value}, which is after ${CUTOFF_TAIL}`,
        });
      }
    }
  });

const UNDO_NOTE =
  'Every row below was changed from `before` to `after` by backfill-snapshot-price-context.ts. Undo: `npx tsx scripts/backfill-snapshot-price-context.ts --undo-file <this file> --apply`, which restores `before` on a row only while it still holds `after`. A `before` of "NaN" is a stored NaN, not NULL.';

const PLAN_NOTE =
  'The plan of a dry run of backfill-snapshot-price-context.ts. Apply exactly this: `npx tsx scripts/backfill-snapshot-price-context.ts --apply --plan <this file>`. `updates` is what is written (a row only where it still holds `before`); `report` is for reading.';

/** The text of one column of a row, for a SQL array. A missing one is a bug. */
function columnText(
  values: Partial<Record<PriceColumn, StoredDecimal>>,
  column: PriceColumn,
): StoredDecimal {
  const value = values[column];
  if (value === undefined) {
    throw new Error(`a planned row has no ${column}: the plan is malformed`);
  }
  return value;
}

/**
 * The open a replayed or close-and-gap row's gap came from, which guards its
 * write. A row of either kind without one is a bug.
 */
function guardOpenOf(row: UndoRow): string {
  if (row.guardOpen == null) {
    throw new Error(
      `planned row ${row.id} has no guard open: the plan is malformed`,
    );
  }
  return row.guardOpen;
}

/**
 * The undo file, written before the first UPDATE. `wx`: a file already there
 * is never overwritten (it is the only record of an earlier run), and `flush`
 * puts it on disk before the first UPDATE can need it. Returns its path.
 */
function writeUndoFile(
  dir: string,
  rows: readonly UndoRow[],
  now: Date,
): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `undo-${now.toISOString().replaceAll(':', '-')}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      note: UNDO_NOTE,
      createdAt: now.toISOString(),
      rows,
    }),
    { flag: 'wx', flush: true },
  );
  return file;
}

/**
 * Move rows from their `from` values to their `to` values, 500 to a
 * statement, each only where the row still holds `from` in every column the
 * update touches (and, for a replayed or close-and-gap row, the open its gap
 * came from, which no update changes, in both directions). The text is cast
 * to numeric in SQL and compared with `IS NOT DISTINCT FROM`: NULL matches
 * NULL, and a stored NaN matches NaN (Postgres numeric treats them as equal),
 * so a row read as NaN is guarded and restored as NaN, never as NULL. `apply`
 * moves before -> after; `undo` moves after -> before. The ids that moved are
 * added to `moved` as each statement finishes, so a failure part-way still says
 * how far it got. A statement is not retried: if its answer were lost after a
 * commit, the retry would match nothing and report the rows as changed.
 */
async function moveRows(
  sql: Sql,
  rows: readonly UndoRow[],
  direction: 'apply' | 'undo',
  moved: Set<number>,
): Promise<void> {
  const forward = direction === 'apply';
  for (const fill of ['all', 'replayed', 'close-and-gap'] as const) {
    const group = rows.filter((r) => r.fill === fill);
    for (let i = 0; i < group.length; i += WRITE_CHUNK) {
      const chunk = group.slice(i, i + WRITE_CHUNK);
      const ids = chunk.map((r) => r.id);
      const from = (column: PriceColumn) =>
        chunk.map((r) => columnText(forward ? r.before : r.after, column));
      const to = (column: PriceColumn) =>
        chunk.map((r) => columnText(forward ? r.after : r.before, column));
      let done: Array<{ id: number }>;
      if (fill === 'all') {
        done = (await sql`
          UPDATE market_snapshots AS t
             SET spx_open = v.to_open::numeric,
                 spx_high = v.to_high::numeric,
                 spx_low = v.to_low::numeric,
                 prev_close = v.to_close::numeric,
                 overnight_gap = v.to_gap::numeric
            FROM unnest(
                   ${ids}::int[],
                   ${from('spx_open')}::text[], ${from('spx_high')}::text[],
                   ${from('spx_low')}::text[], ${from('prev_close')}::text[],
                   ${from('overnight_gap')}::text[],
                   ${to('spx_open')}::text[], ${to('spx_high')}::text[],
                   ${to('spx_low')}::text[], ${to('prev_close')}::text[],
                   ${to('overnight_gap')}::text[]
                 ) AS v(id, from_open, from_high, from_low, from_close,
                        from_gap, to_open, to_high, to_low, to_close, to_gap)
           WHERE t.id = v.id
             AND t.spx_open IS NOT DISTINCT FROM v.from_open::numeric
             AND t.spx_high IS NOT DISTINCT FROM v.from_high::numeric
             AND t.spx_low IS NOT DISTINCT FROM v.from_low::numeric
             AND t.prev_close IS NOT DISTINCT FROM v.from_close::numeric
             AND t.overnight_gap IS NOT DISTINCT FROM v.from_gap::numeric
          RETURNING t.id
        `) as Array<{ id: number }>;
      } else if (fill === 'replayed') {
        done = (await sql`
          UPDATE market_snapshots AS t
             SET spx_high = v.to_high::numeric,
                 spx_low = v.to_low::numeric,
                 prev_close = v.to_close::numeric,
                 overnight_gap = v.to_gap::numeric
            FROM unnest(
                   ${ids}::int[],
                   ${chunk.map(guardOpenOf)}::text[],
                   ${from('spx_high')}::text[], ${from('spx_low')}::text[],
                   ${from('prev_close')}::text[],
                   ${from('overnight_gap')}::text[],
                   ${to('spx_high')}::text[], ${to('spx_low')}::text[],
                   ${to('prev_close')}::text[],
                   ${to('overnight_gap')}::text[]
                 ) AS v(id, guard_open, from_high, from_low, from_close,
                        from_gap, to_high, to_low, to_close, to_gap)
           WHERE t.id = v.id
             AND t.spx_open IS NOT DISTINCT FROM v.guard_open::numeric
             AND t.spx_high IS NOT DISTINCT FROM v.from_high::numeric
             AND t.spx_low IS NOT DISTINCT FROM v.from_low::numeric
             AND t.prev_close IS NOT DISTINCT FROM v.from_close::numeric
             AND t.overnight_gap IS NOT DISTINCT FROM v.from_gap::numeric
          RETURNING t.id
        `) as Array<{ id: number }>;
      } else {
        done = (await sql`
          UPDATE market_snapshots AS t
             SET prev_close = v.to_close::numeric,
                 overnight_gap = v.to_gap::numeric
            FROM unnest(
                   ${ids}::int[],
                   ${chunk.map(guardOpenOf)}::text[],
                   ${from('prev_close')}::text[],
                   ${from('overnight_gap')}::text[],
                   ${to('prev_close')}::text[],
                   ${to('overnight_gap')}::text[]
                 ) AS v(id, guard_open, from_close, from_gap, to_close,
                        to_gap)
           WHERE t.id = v.id
             AND t.spx_open IS NOT DISTINCT FROM v.guard_open::numeric
             AND t.prev_close IS NOT DISTINCT FROM v.from_close::numeric
             AND t.overnight_gap IS NOT DISTINCT FROM v.from_gap::numeric
          RETURNING t.id
        `) as Array<{ id: number }>;
      }
      for (const r of done) moved.add(r.id);
    }
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

/** One date: what was read, what the history gave, and what the plan did. */
export interface DatePlan {
  date: string;
  rows: SnapshotRowIn[];
  /**
   * `ok`: candles read. `failed`: see detail (an empty answer included).
   * `not-fetched`: not a trading day, so no request was made.
   */
  fetch: 'ok' | 'failed' | 'not-fetched';
  /** Why the fetch failed; null otherwise. */
  fetchDetail: string | null;
  results: PlanResult[];
  skippedDate: DateSkipReason | null;
  pickChange: { from: number | null; to: number | null } | null;
  /** The previous close the history gave, once it was a valid one. */
  previousClose: number | null;
  /** `outcomes.settlement` of the prior trading day; null when there is none. */
  settlement: number | null;
}

export interface DryRunResult {
  since: string | null;
  until: string;
  dates: DatePlan[];
  /** Dates the fetch loop never reached because it stopped (MAX_SAME_FAILURES). */
  untried: string[];
  /** The plan file the dry run left, for `--apply --plan`. */
  planFile: string;
}

/** A path as the reports print it: forward slashes, which Git Bash can paste. */
const fwd = (path: string): string => path.replaceAll('\\', '/');

/** The host of a database URL: never its user, password or path. */
function hostOf(databaseUrl: string | undefined): string {
  try {
    return new URL(databaseUrl ?? '').hostname || '(DATABASE_URL has no host)';
  } catch {
    return '(DATABASE_URL missing or not a URL)';
  }
}

/**
 * Every planned row of the dates, as the plan file and the undo file hold
 * it. Throws on a planned result whose row was not read: the plan would be
 * missing a row it counts.
 */
export function updatesOf(dates: readonly DatePlan[]): UndoRow[] {
  return dates.flatMap((d) => {
    const byId = new Map(d.rows.map((r) => [r.id, r]));
    return d.results.flatMap((r) => {
      if (r.kind !== 'update') return [];
      const row = byId.get(r.id);
      if (row == null) {
        throw new Error(
          `planned row ${r.id} has no row among the rows read for ${d.date}: the plan would be missing it`,
        );
      }
      return [
        {
          id: r.id,
          date: row.date,
          entryTime: row.entry_time,
          fill: r.fill,
          before: r.before,
          after: r.after,
          ...(r.guardOpen == null ? {} : { guardOpen: r.guardOpen }),
        },
      ];
    });
  });
}

export interface Reconciliation {
  read: number;
  planned: number;
  /** Rows that already hold every planned value. */
  alreadyRight: number;
  /**
   * Rows with an open whose previous close and gap are right, but whose high
   * and low were left as stored because the candles are bad: not "already
   * right", since nothing says the high and low are.
   */
  partlyRight: number;
  leftAlone: number;
  onSkippedDates: number;
}

/**
 * Every row read is planned, already right, partly right, left alone, or on a
 * date skipped whole, and counted once. Throws when the five do not add up to
 * the rows read: a planner that dropped or repeated a row would otherwise go
 * unnoticed.
 */
export function reconcile(dates: readonly DatePlan[]): Reconciliation {
  const counts = {
    read: 0,
    planned: 0,
    alreadyRight: 0,
    partlyRight: 0,
    leftAlone: 0,
    onSkippedDates: 0,
  };
  for (const d of dates) {
    counts.read += d.rows.length;
    if (d.skippedDate != null) counts.onSkippedDates += d.rows.length;
    for (const r of d.results) {
      if (r.kind === 'update') counts.planned += 1;
      else if (r.reason !== 'unchanged') counts.leftAlone += 1;
      else if (r.highLowLeft === true) counts.partlyRight += 1;
      else counts.alreadyRight += 1;
    }
  }
  const { read, planned, alreadyRight, partlyRight } = counts;
  const { leftAlone, onSkippedDates } = counts;
  const accounted =
    planned + alreadyRight + partlyRight + leftAlone + onSkippedDates;
  if (read !== accounted) {
    throw new Error(
      `the row counts do not reconcile: read ${read}, planned ${planned}, already right ${alreadyRight}, left alone ${leftAlone}, on skipped dates ${onSkippedDates}, partly right ${partlyRight}`,
    );
  }
  return counts;
}

/** The progress line a date prints to stderr once it is planned. */
function progressLine(d: DatePlan): string {
  if (d.skippedDate == null) return `${d.date} fetched`;
  const detail = d.fetchDetail == null ? '' : ` (${d.fetchDetail})`;
  return `${d.date} skipped ${d.skippedDate}${detail}`;
}

/** The stamp of a file name: the time, with no colon (a Windows path). */
const stampOf = (now: Date): string => now.toISOString().replaceAll(':', '-');

/**
 * The plan file: `updates` is what `--apply --plan` writes (every planned row
 * with its raw `before` text and its `after` text), `dbHost` is the database
 * it was read from, `report` is the rest of the dry run for reading. It is the
 * shape `PlanFileSchema` checks. Refuses dates that do not reconcile, and a
 * plan whose updates are not the planned rows. `wx`: a file already there is
 * never overwritten. Returns its path.
 */
export function writePlanFile(
  dir: string,
  run: {
    since: string | null;
    until: string;
    dates: readonly DatePlan[];
    untried: readonly string[];
  },
  now: Date,
): string {
  const updates = updatesOf(run.dates);
  const { planned } = reconcile(run.dates);
  if (updates.length !== planned) {
    throw new Error(
      `the plan has ${updates.length} updates for ${planned} planned rows`,
    );
  }
  const body = {
    note: PLAN_NOTE,
    createdAt: now.toISOString(),
    dbHost: hostOf(process.env.DATABASE_URL),
    since: run.since,
    until: run.until,
    summary: summaryLine(run.dates, run.untried.length),
    updates,
    report: {
      untried: run.untried,
      dates: run.dates.map((d) => ({
        date: d.date,
        rows: d.rows.length,
        fetch: d.fetch,
        fetchDetail: d.fetchDetail,
        skippedDate: d.skippedDate,
        previousClose: d.previousClose,
        settlement: d.settlement,
        pickChange: d.pickChange,
        skips: d.results.flatMap((r) => (r.kind === 'skip' ? [r] : [])),
      })),
    },
  };
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `dry-run-${stampOf(now)}.json`);
  writeFileSync(file, JSON.stringify(body), { flag: 'wx', flush: true });
  return file;
}

interface Streak {
  detail: string;
  count: number;
}

/**
 * Dates in a row that failed with the same detail. A success, a different
 * failure, or an empty history (which every date older than Schwab's window
 * answers, so a full run meets many in a row) ends it; a date that is not a
 * trading day, never fetched, neither counts nor ends it.
 */
function nextStreak(streak: Streak, plan: DatePlan): Streak {
  if (plan.fetch === 'not-fetched') return streak;
  const detail = plan.fetchDetail;
  if (plan.fetch !== 'failed' || detail == null || detail === EMPTY_HISTORY) {
    return { detail: '', count: 0 };
  }
  return { detail, count: detail === streak.detail ? streak.count + 1 : 1 };
}

/**
 * Read the dates in range, and for each trading day fetch its history, read
 * its rows and plan it, with the prior session's `outcomes.settlement` (one
 * read-only query for all of them) as the cross-check on its previous close.
 * A date that is not a trading day is skipped before any fetch. Stops after
 * MAX_SAME_FAILURES dates in a row fail the same way, and lists the dates it
 * never reached. Writes nothing to the database; leaves the plan file. A
 * progress line per date goes to stderr. Every refusal throws before the plan
 * file is written: a missing variable, an empty range, a refused cookie. A DB
 * error propagates.
 */
export async function runDryRun(opts: {
  since: string | null;
  until: string | null;
  undoDir: string;
}): Promise<DryRunResult> {
  const access = historyAccess(process.env);
  const sql = getDb();
  const today = getETToday();
  // Never past today (no history yet) nor past the last replay date.
  const latest = today < LAST_REPLAY_DATE ? today : LAST_REPLAY_DATE;
  const until = opts.until != null && opts.until < latest ? opts.until : latest;
  const days = await readDates(sql, opts.since ?? FIRST_HISTORY_DATE, until);
  if (days.length === 0) {
    throw new Error(
      `Refusing to run: no market_snapshots rows dated ${opts.since ?? 'ever'} to ${until}.`,
    );
  }
  const settlements = await readSettlements(sql, days);

  const dates: DatePlan[] = [];
  const untried: string[] = [];
  let fetchedBefore = false;
  let streak: Streak = { detail: '', count: 0 };
  for (const [index, date] of days.entries()) {
    const tradingDay = isTradingDay(date);
    let history: DateHistory | null = null;
    let failure: string | null = null;
    if (tradingDay) {
      // The pause is between fetches: a date never fetched waits for nothing.
      if (fetchedBefore) await sleep(FETCH_PAUSE_MS);
      fetchedBefore = true;
      const fetched = await fetchHistory(access, date);
      if (fetched.kind === 'denied') {
        throw new Error(
          `Refusing to go on. ${date}: /api/history answered ${fetched.status}: the owner cookie was refused. Check OWNER_SECRET. Nothing was written.`,
        );
      }
      if (fetched.kind === 'logged-out') {
        throw new Error(
          `Refusing to go on. ${date}: Schwab is logged out (/api/history answered ${fetched.status}). Log in to Schwab, then re-run. Nothing was written.`,
        );
      }
      if (fetched.kind === 'ok') history = fetched.history;
      else failure = fetched.detail;
    }
    // Read after the fetch, so the rows are as fresh as the plan can have.
    const rows = await readRows(sql, date);
    const settlement = settlements.get(priorTradingDay(date)) ?? null;
    const { results, skippedDate, previousClose } = planDate(
      date,
      rows,
      history,
      settlement,
    );
    const plan: DatePlan = {
      date,
      rows,
      fetch: !tradingDay ? 'not-fetched' : failure == null ? 'ok' : 'failed',
      fetchDetail: failure,
      results,
      skippedDate: skippedDate ?? null,
      pickChange: featurePickChange(rows, results),
      previousClose: previousClose ?? null,
      settlement,
    };
    dates.push(plan);
    console.error(progressLine(plan));
    streak = nextStreak(streak, plan);
    if (streak.count >= MAX_SAME_FAILURES) {
      untried.push(...days.slice(index + 1));
      break;
    }
  }

  reconcile(dates);
  const planFile = writePlanFile(
    opts.undoDir,
    { since: opts.since, until, dates, untried },
    new Date(),
  );
  return { since: opts.since, until, dates, untried, planFile };
}

export interface ApplyResult {
  /** False: the plan was only counted. */
  apply: boolean;
  file: string;
  /** From the plan file: when the dry run was made, its range and database. */
  createdAt: string;
  since: string | null;
  until: string;
  dbHost: string;
  /** The last line of the dry run's report. */
  summary: string;
  planned: number;
  written: number;
  /**
   * Planned rows the guard did not match that already hold the plan's `after`
   * values: an earlier apply of this plan wrote them.
   */
  alreadyAppliedIds: number[];
  /** Planned rows that were neither written nor already applied: changed. */
  unwrittenIds: number[];
  /** Null unless something was to be written. */
  undoFile: string | null;
  reportFile: string | null;
  /** Why the apply report could not be written, though the rows were. */
  reportError: string | null;
  /** Why the unwritten rows could not be checked against the plan. */
  checkError: string | null;
}

/** The byte-order mark a Windows editor may put at the start of a file. */
const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);

/** The JSON in a file, read past a byte-order mark if there is one. */
function readJsonFile(file: string): unknown {
  const raw = readFileSync(file, 'utf8');
  const text = raw.startsWith(BYTE_ORDER_MARK) ? raw.slice(1) : raw;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${fwd(file)} is not valid JSON`, { cause: err });
  }
}

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return `${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim();
}

/**
 * The apply report: what the apply planned, wrote and left, and where the
 * undo file is. Written when the apply ends, and when it fails (with the
 * error), next to the undo file. `wx`, like the other files.
 */
function writeApplyReport(
  dir: string,
  body: {
    planFile: string;
    undoFile: string;
    planned: number;
    written: number;
    alreadyAppliedIds: number[];
    unwrittenIds: number[];
    checkError: string | null;
    error: string | null;
  },
  now: Date,
): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `apply-${stampOf(now)}.json`);
  writeFileSync(
    file,
    JSON.stringify({ createdAt: now.toISOString(), ...body }),
    { flag: 'wx', flush: true },
  );
  return file;
}

/**
 * Of the planned rows an UPDATE did not write, the ids of those that already
 * hold every `after` value of their update: an earlier apply of this plan
 * wrote them. One read-only query per 5000 rows.
 */
async function readAlreadyApplied(
  sql: Sql,
  rows: readonly UndoRow[],
): Promise<Set<number>> {
  const applied = new Set<number>();
  for (let i = 0; i < rows.length; i += READ_CHUNK) {
    const chunk = rows.slice(i, i + READ_CHUNK);
    const ids = chunk.map((r) => r.id);
    const stored = (await withDbRetry(
      () => sql`
        SELECT id, spx_open::text AS spx_open, spx_high::text AS spx_high,
               spx_low::text AS spx_low, prev_close::text AS prev_close,
               overnight_gap::text AS overnight_gap
          FROM market_snapshots
         WHERE id = ANY(${ids}::int[])
      `,
    )) as Array<{ id: number } & PriceValues>;
    const byId = new Map(chunk.map((r) => [r.id, r]));
    for (const row of stored) {
      const planned = byId.get(row.id);
      const holds = COLUMNS_OF[planned?.fill ?? 'all'].every((column) => {
        const want = planned?.after[column];
        return want != null && sameDecimal(row[column], want);
      });
      if (planned != null && holds) applied.add(row.id);
    }
  }
  return applied;
}

/**
 * Apply exactly the plan file a dry run left: no fetch, no re-plan, no
 * OWNER_SECRET. The file is checked with a strict schema first, and refused
 * unless DATABASE_URL points at the host the plan was read from, before any
 * file or statement. With `apply`, the undo file is written, then the rows,
 * 500 to a statement, each only where it still holds the values the dry run
 * read; then the rows no statement wrote are read back, to tell those an
 * earlier apply of this plan already wrote from those that changed; then the
 * apply report. A DB error names the undo file and how far the apply got,
 * and the report is written for it too. A report that cannot be written does
 * not hide the rows that were. Without `apply` the plan is only counted.
 */
export async function runApply(opts: {
  file: string;
  apply: boolean;
  undoDir: string;
}): Promise<ApplyResult> {
  const parsed = PlanFileSchema.safeParse(readJsonFile(opts.file));
  if (!parsed.success) {
    throw new Error(
      `${fwd(opts.file)} is not a plan file from this script: ${describeIssue(parsed.error)}`,
    );
  }
  const plan = parsed.data;
  const planned = plan.updates.length;
  const head = {
    apply: opts.apply,
    file: opts.file,
    createdAt: plan.createdAt,
    since: plan.since,
    until: plan.until,
    dbHost: plan.dbHost,
    summary: plan.summary,
    planned,
  };
  const idle = {
    written: 0,
    alreadyAppliedIds: [],
    unwrittenIds: [],
    undoFile: null,
    reportFile: null,
    reportError: null,
    checkError: null,
  };
  if (!opts.apply) return { ...head, ...idle };

  const current = hostOf(process.env.DATABASE_URL);
  if (current !== plan.dbHost) {
    throw new Error(
      `Refusing to apply: the plan was made against the database host ${plan.dbHost}, but DATABASE_URL points at ${current}. Nothing was written.`,
    );
  }
  if (planned === 0) return { ...head, ...idle };

  const now = new Date();
  const undoFile = writeUndoFile(opts.undoDir, plan.updates, now);
  const written = new Set<number>();
  const sql = getDb();
  try {
    await moveRows(sql, plan.updates, 'apply', written);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    let reported = '';
    try {
      const reportFile = writeApplyReport(
        opts.undoDir,
        {
          planFile: opts.file,
          undoFile,
          planned,
          written: written.size,
          alreadyAppliedIds: [],
          unwrittenIds: plan.updates
            .map((r) => r.id)
            .filter((id) => !written.has(id)),
          checkError: null,
          error: reason,
        },
        now,
      );
      reported = ` The apply report ${fwd(reportFile)} lists the rows not written.`;
    } catch {
      // The failure to explain is not the failure to report.
    }
    throw new Error(
      `${reason}. The apply did not complete: ${written.size} of ${planned} planned rows were written before it failed. The undo file ${fwd(undoFile)} lists every planned row and restores only those that were written.${reported} Run a dry run to see what is left.`,
      { cause: err },
    );
  }

  // A row no statement wrote did not match the plan's `before` values: it
  // changed since the dry run, or an earlier apply of this plan wrote it.
  const left = plan.updates.filter((r) => !written.has(r.id));
  let appliedBefore = new Set<number>();
  let checkError: string | null = null;
  if (left.length > 0) {
    try {
      appliedBefore = await readAlreadyApplied(sql, left);
    } catch (err) {
      checkError = err instanceof Error ? err.message : String(err);
    }
  }
  const alreadyAppliedIds = left
    .filter((r) => appliedBefore.has(r.id))
    .map((r) => r.id);
  const unwrittenIds = left
    .filter((r) => !appliedBefore.has(r.id))
    .map((r) => r.id);
  let reportFile: string | null = null;
  let reportError: string | null = null;
  try {
    reportFile = writeApplyReport(
      opts.undoDir,
      {
        planFile: opts.file,
        undoFile,
        planned,
        written: written.size,
        alreadyAppliedIds,
        unwrittenIds,
        checkError,
        error: null,
      },
      now,
    );
  } catch (err) {
    reportError = err instanceof Error ? err.message : String(err);
  }
  return {
    ...head,
    written: written.size,
    alreadyAppliedIds,
    unwrittenIds,
    undoFile,
    reportFile,
    reportError,
    checkError,
  };
}

export interface UndoResult {
  apply: boolean;
  file: string;
  rows: number;
  restored: number;
  /** Rows that no longer held the planned values: another writer changed them. */
  changedIds: number[];
}

/** Restore the old values from an undo file, only where a row still holds the new ones. */
export async function runUndo(opts: {
  file: string;
  apply: boolean;
}): Promise<UndoResult> {
  const parsed = UndoFileSchema.safeParse(readJsonFile(opts.file));
  if (!parsed.success) {
    throw new Error(
      `${fwd(opts.file)} is not an undo file from this script: ${describeIssue(parsed.error)}`,
    );
  }
  const { rows } = parsed.data;
  const restored = new Set<number>();
  if (opts.apply) {
    try {
      await moveRows(getDb(), rows, 'undo', restored);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${reason}. The undo did not complete: ${restored.size} of ${rows.length} rows were restored before it failed. It is safe to repeat: a row already restored no longer holds the new values and is skipped.`,
        { cause: err },
      );
    }
  }
  return {
    apply: opts.apply,
    file: opts.file,
    rows: rows.length,
    restored: restored.size,
    changedIds: opts.apply
      ? rows.map((r) => r.id).filter((id) => !restored.has(id))
      : [],
  };
}

// ── Exit codes ──────────────────────────────────────────────────────────────

/** 1 when any date's history failed (an empty one included), or the loop stopped. */
export function exitCodeOfDryRun(result: DryRunResult): 0 | 1 {
  return result.untried.length > 0 ||
    result.dates.some((d) => d.fetch === 'failed')
    ? 1
    : 0;
}

/**
 * 1 whenever a planned row was neither written nor already applied, and when
 * the apply report could not be written. Rows an earlier apply of the plan
 * wrote are not a shortfall.
 */
export function exitCodeOfApply(result: ApplyResult): 0 | 1 {
  if (!result.apply) return 0;
  const accounted = result.written + result.alreadyAppliedIds.length;
  return accounted < result.planned || result.reportError != null ? 1 : 0;
}

/** 1 whenever an undo restored fewer rows than the file holds. */
export function exitCodeOfUndo(result: UndoResult): 0 | 1 {
  return result.apply && result.restored < result.rows ? 1 : 0;
}

// ── Report ──────────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

/** The first `LIST_SHOWN` items joined, then "and N more". */
function shownList(items: readonly string[]): string {
  const shown = items.slice(0, LIST_SHOWN).join(', ');
  return items.length > LIST_SHOWN
    ? `${shown}, and ${items.length - LIST_SHOWN} more`
    : shown;
}

/** Counts as " (name n, name m)", the zero ones left out; "" when none. */
function reasonList(pairs: ReadonlyArray<readonly [string, number]>): string {
  const shown = pairs
    .filter(([, n]) => n > 0)
    .map(([name, n]) => `${name} ${n}`);
  return shown.length === 0 ? '' : ` (${shown.join(', ')})`;
}

const cell = (value: StoredDecimal | undefined): string => value ?? 'NULL';

/** A number to 2 decimals for the report, or as it is when it has none. */
const showValue = (value: number): string =>
  Number.isFinite(value) && Math.abs(value) < 1e21
    ? toDecimal2(value)
    : String(value);

function describeSample(row: SnapshotRowIn, update: PlannedUpdate): string {
  const changes = COLUMNS_OF[update.fill].map(
    (c) => `${c} ${cell(update.before[c])} -> ${update.after[c] ?? '?'}`,
  );
  return `    id ${row.id} ${row.date} ${row.entry_time}: ${changes.join(', ')}`;
}

/** The first and the last of a date-ordered list: a spread for a hand check. */
const sampleOf = <T>(items: readonly T[]): T[] =>
  items.length <= 2 ? [...items] : [items[0] as T, items.at(-1) as T];

/** The planned kinds, as the report names them. */
const FILL_LABELS: ReadonlyArray<readonly [FillKind, string]> = [
  ['all', 'fill all five columns'],
  ['replayed', 'replayed rows: high, low, previous close, gap'],
  ['close-and-gap', 'previous close and gap only (bad candles)'],
];

/** The dates skipped whole, in the order the report and the summary give them. */
const DATE_REASONS: ReadonlyArray<readonly [DateSkipReason, string]> = [
  ['not-a-trading-day', 'not-a-trading-day'],
  ['no-history', 'history fetch failed'],
  ['short-candles', 'short-candles'],
  ['no-previous-day', 'no-previous-day'],
  ['prev-close-mismatch', 'prev-close-mismatch'],
  ['bad-previous-close', 'bad-previous-close'],
];
const ROW_REASONS: readonly RowSkipReason[] = [
  'no-slot',
  'before-open',
  'bad-candles',
  'open-mismatch',
  'unchanged',
];

interface Counts {
  planned: number;
  /** Planned updates by kind. */
  byFill: Record<FillKind, number>;
  rowSkips: Record<RowSkipReason, number>;
  /** `unchanged` rows whose high and low were left as stored (bad candles). */
  partlyRight: number;
  datesByReason: Map<DateSkipReason, DatePlan[]>;
  skippedDates: number;
  rowsOnSkippedDates: number;
}

function countsOf(dates: readonly DatePlan[]): Counts {
  const counts: Counts = {
    planned: 0,
    byFill: { all: 0, replayed: 0, 'close-and-gap': 0 },
    rowSkips: {
      'no-slot': 0,
      'before-open': 0,
      'bad-candles': 0,
      'open-mismatch': 0,
      unchanged: 0,
    },
    partlyRight: 0,
    datesByReason: new Map(),
    skippedDates: 0,
    rowsOnSkippedDates: 0,
  };
  for (const d of dates) {
    if (d.skippedDate != null) {
      counts.skippedDates += 1;
      counts.rowsOnSkippedDates += d.rows.length;
      counts.datesByReason.set(d.skippedDate, [
        ...(counts.datesByReason.get(d.skippedDate) ?? []),
        d,
      ]);
    }
    for (const r of d.results) {
      if (r.kind === 'update') {
        counts.planned += 1;
        counts.byFill[r.fill] += 1;
        continue;
      }
      counts.rowSkips[r.reason] += 1;
      if (r.reason === 'unchanged' && r.highLowLeft === true) {
        counts.partlyRight += 1;
      }
    }
  }
  return counts;
}

/**
 * The last line of every dry-run report, kept in the plan file too: what was
 * planned, and how many dates and rows were not planned, and why. It says
 * nothing would be written only when nothing at all was skipped.
 */
function summaryLine(dates: readonly DatePlan[], untried = 0): string {
  const c = countsOf(dates);
  const leftAlone =
    c.rowSkips['no-slot'] +
    c.rowSkips['before-open'] +
    c.rowSkips['bad-candles'] +
    c.rowSkips['open-mismatch'];
  // "Right" is every planned value held. A row whose candles are bad has only
  // its previous close and gap checked: it is counted apart, never as right.
  const partly = c.partlyRight;
  const right = c.rowSkips.unchanged - partly;
  if (
    c.planned === 0 &&
    c.skippedDates === 0 &&
    leftAlone === 0 &&
    untried === 0
  ) {
    if (partly === 0) {
      return right === 1
        ? 'Nothing to write: all 1 row already holds its planned values.'
        : `Nothing to write: all ${right} rows already hold their planned values.`;
    }
    const held =
      right === 1
        ? '1 row already holds its planned values'
        : `${right} rows already hold their planned values`;
    const kept =
      partly === 1
        ? '1 row holds its planned previous close and gap'
        : `${partly} rows hold their planned previous close and gap`;
    const lead = right === 0 ? '' : `${held}; `;
    return `Nothing to write: ${lead}${kept}, with the high and low left as stored (bad candles).`;
  }
  const dateReasons = reasonList(
    DATE_REASONS.map(
      ([reason, label]) =>
        [label, c.datesByReason.get(reason)?.length ?? 0] as const,
    ),
  );
  const leftReasons = reasonList(
    ROW_REASONS.filter((r) => r !== 'unchanged').map(
      (r) => [r, c.rowSkips[r]] as const,
    ),
  );
  const parts = [
    `Planned ${plural(c.planned, 'update')}. Not planned: ${plural(c.skippedDates, 'date')} with ${plural(c.rowsOnSkippedDates, 'row')}${dateReasons}`,
  ];
  if (leftAlone > 0) {
    parts.push(`${plural(leftAlone, 'row')} left alone${leftReasons}`);
  }
  if (right > 0) parts.push(`${plural(right, 'row')} already right`);
  if (partly > 0) {
    parts.push(
      `${plural(partly, 'row')} with only the previous close and gap right (high/low left as stored)`,
    );
  }
  if (untried > 0) parts.push(`${plural(untried, 'date')} never tried`);
  return `${parts.join('; ')}.`;
}

function dateSkipLines(dates: readonly DatePlan[]): string[] {
  const lines = ['Dates skipped whole (their rows are not planned):'];
  const counts = countsOf(dates);
  for (const [reason, label] of DATE_REASONS) {
    const hit = counts.datesByReason.get(reason) ?? [];
    const rows = hit.reduce((n, d) => n + d.rows.length, 0);
    const head = `${label}:`.padEnd(40);
    lines.push(
      `  ${head} ${plural(hit.length, 'date')} (${plural(rows, 'row')})`,
    );
    if (reason === 'no-history') {
      // One line per cause: a run over old dates would otherwise list the same
      // empty-history message for every one of them.
      const byDetail = new Map<string, string[]>();
      for (const d of hit) {
        const detail = d.fetchDetail ?? '(no detail)';
        byDetail.set(detail, [...(byDetail.get(detail) ?? []), d.date]);
      }
      for (const [detail, days] of byDetail) {
        lines.push(
          `    ${detail} (${plural(days.length, 'date')}): ${shownList(days)}`,
        );
      }
    } else if (reason === 'prev-close-mismatch') {
      for (const d of hit.slice(0, LIST_SHOWN)) {
        const close = d.previousClose ?? Number.NaN;
        const settlement = d.settlement ?? Number.NaN;
        lines.push(
          `    ${d.date}: previous close ${showValue(close)}, settlement ${showValue(settlement)}, difference ${showValue(Math.abs(close - settlement))}`,
        );
      }
      if (hit.length > LIST_SHOWN) {
        lines.push(`    and ${hit.length - LIST_SHOWN} more`);
      }
    } else if (reason === 'bad-previous-close') {
      for (const d of hit.slice(0, LIST_SHOWN)) {
        lines.push(
          `    ${d.date}: previous close ${String(d.previousClose)}, which gives no price or gap a column holds`,
        );
      }
      if (hit.length > LIST_SHOWN) {
        lines.push(`    and ${hit.length - LIST_SHOWN} more`);
      }
    } else if (hit.length > 0) {
      lines.push(`    ${shownList(hit.map((d) => d.date))}`);
    }
  }
  return lines;
}

function crossCheckLines(dates: readonly DatePlan[]): string[] {
  const planned = dates.filter(
    (d) => d.skippedDate == null && d.previousClose != null,
  );
  const checked = planned.filter((d) => d.settlement != null);
  const unchecked = planned.filter((d) => d.settlement == null);
  // The report's numbers come from the constants, so they cannot drift.
  const inDollars = (cents: number): string => (cents / 100).toFixed(2);
  const within = inDollars(SETTLEMENT_TOLERANCE_CENTS);
  const reported = inDollars(SETTLEMENT_REPORT_CENTS);
  // Planned, yet more than 0.05 off: the likely cause is a settlement that is
  // the official close (a fetch-outcomes backfill), so the owner sees each one.
  const off = planned.flatMap((d) => {
    if (d.previousClose == null || d.settlement == null) return [];
    const cents = settlementCents(d.previousClose, d.settlement);
    return cents > SETTLEMENT_REPORT_CENTS
      ? [`${d.date} (${inDollars(cents)})`]
      : [];
  });
  const listOf = (items: readonly string[]): string =>
    items.length === 0 ? '' : `: ${shownList(items)}`;
  return [
    `Previous close within ${within} of outcomes.settlement: ${plural(checked.length, 'date')} (a settlement from the end-of-day run is the last 5-minute bar's close, the same feed as the previous close; one from a fetch-outcomes backfill is the official close, which can differ from the 5-minute close by a point or two)`,
    `Previous close more than ${reported} from outcomes.settlement, planned (the prior day's settlement is likely the official close from a fetch-outcomes backfill): ${plural(off.length, 'date')}${listOf(off)}`,
    `Previous close not cross-checked (no outcomes.settlement for the prior trading day), planned anyway: ${plural(unchecked.length, 'date')}${listOf(unchecked.map((d) => d.date))}`,
  ];
}

interface ColumnStats {
  fills: number;
  same: number;
  small: number;
  medium: number;
  large: number;
  largest: { cents: number; id: number; date: string } | null;
}

const COLUMN_ORDER: readonly PriceColumn[] = [
  'spx_open',
  'spx_high',
  'spx_low',
  'prev_close',
  'overnight_gap',
];

/**
 * How a column's overwrites are bucketed, in hundredths of its unit: prices
 * (same / 0.05 / 1 / more) and the gap, which is in percentage points
 * (same / 0.01 / 0.1 / more), where a price-sized bucket would hide a change.
 */
interface Scale {
  small: number;
  medium: number;
  smallLabel: string;
  mediumLabel: string;
  unit: string;
}
const PRICE_SCALE: Scale = {
  small: 5,
  medium: 100,
  smallLabel: '0.05',
  mediumLabel: '1',
  unit: '',
};
const GAP_SCALE: Scale = {
  small: 1,
  medium: 10,
  smallLabel: '0.01',
  mediumLabel: '0.1',
  unit: ' pp',
};
const scaleOf = (column: PriceColumn): Scale =>
  column === 'overnight_gap' ? GAP_SCALE : PRICE_SCALE;

/**
 * Per written column: the values that fill a NULL or NaN apart from the ones
 * that overwrite a value, the overwrites bucketed by the size of the change
 * (none, small, medium, more: see `Scale`), and the largest change with its
 * row.
 */
function columnStats(
  dates: readonly DatePlan[],
): Map<PriceColumn, ColumnStats> {
  const stats = new Map<PriceColumn, ColumnStats>();
  for (const d of dates) {
    for (const r of d.results) {
      if (r.kind !== 'update') continue;
      for (const column of COLUMNS_OF[r.fill]) {
        const s = stats.get(column) ?? {
          fills: 0,
          same: 0,
          small: 0,
          medium: 0,
          large: 0,
          largest: null,
        };
        stats.set(column, s);
        const before = storedNumber(r.before[column] ?? null);
        if (before == null) {
          s.fills += 1;
          continue;
        }
        const scale = scaleOf(column);
        const cents = Math.round(
          Math.abs(Number(r.after[column]) - before) * 100,
        );
        if (cents === 0) s.same += 1;
        else if (cents <= scale.small) s.small += 1;
        else if (cents <= scale.medium) s.medium += 1;
        else s.large += 1;
        if (cents > (s.largest?.cents ?? 0)) {
          s.largest = { cents, id: r.id, date: d.date };
        }
      }
    }
  }
  return stats;
}

function columnLines(dates: readonly DatePlan[]): string[] {
  const stats = columnStats(dates);
  const lines = [
    'Changes by column (a fill replaces a NULL or NaN; an overwrite replaces a value; overnight_gap changes are in percentage points):',
  ];
  for (const column of COLUMN_ORDER) {
    const s = stats.get(column);
    if (s == null) continue;
    const scale = scaleOf(column);
    const overwrites = s.same + s.small + s.medium + s.large;
    const buckets =
      overwrites === 0
        ? ''
        : ` (same ${s.same}, <=${scale.smallLabel} ${s.small}, <=${scale.mediumLabel} ${s.medium}, >${scale.mediumLabel} ${s.large})`;
    const largest =
      s.largest == null
        ? ''
        : `, largest change ${(s.largest.cents / 100).toFixed(2)}${scale.unit} (id ${s.largest.id}, ${s.largest.date})`;
    const name = column.padEnd(14);
    lines.push(
      `  ${name} fill ${s.fills}, overwrite ${overwrites}${buckets}${largest}`,
    );
  }
  return lines;
}

/** The reasons a row is left alone: "already right" is not one of them. */
const LEFT_ALONE_REASONS: readonly RowSkipReason[] = ROW_REASONS.filter(
  (r) => r !== 'unchanged',
);

/** `date: id, id (detail), ...` lines, one per date, each capped by `shownList`. */
function byDateLines(byDate: ReadonlyMap<string, readonly string[]>): string[] {
  return [...byDate].map(([date, items]) => `  ${date}: ${shownList(items)}`);
}

/** A row id to the date's list, in the map. */
function addTo(
  map: Map<string, string[]>,
  date: string,
  item: string | number,
): void {
  map.set(date, [...(map.get(date) ?? []), String(item)]);
}

function skipLines(dates: readonly DatePlan[]): string[] {
  const counts = countsOf(dates);
  const badCandles = new Map<string, string[]>();
  const highLowLeft = new Map<string, string[]>();
  const mismatched = new Map<string, string[]>();
  for (const d of dates) {
    for (const r of d.results) {
      if (r.kind === 'skip' && r.reason === 'bad-candles') {
        addTo(badCandles, d.date, r.id);
      }
      if (r.kind === 'skip' && r.reason === 'open-mismatch') {
        addTo(mismatched, d.date, `${r.id} (${r.detail ?? ''})`);
      }
      const left =
        (r.kind === 'update' && r.fill === 'close-and-gap') ||
        (r.kind === 'skip' && r.highLowLeft === true);
      if (left) addTo(highLowLeft, d.date, r.id);
    }
  }
  const total = (map: ReadonlyMap<string, readonly string[]>): number =>
    [...map.values()].reduce((n, items) => n + items.length, 0);
  const lines = [
    'Rows left alone:',
    ...LEFT_ALONE_REASONS.map((reason) => {
      const label = `${reason}:`.padEnd(14);
      return `  ${label} ${counts.rowSkips[reason]}`;
    }),
    `Rows already right (they hold their planned values): ${counts.rowSkips.unchanged - counts.partlyRight}`,
  ];
  if (counts.partlyRight > 0) {
    lines.push(
      `Rows with only the previous close and gap right, high/low left as stored (bad candles): ${counts.partlyRight}`,
    );
  }
  if (badCandles.size > 0) {
    lines.push(
      '',
      `WARNING: ${plural(total(badCandles), 'row')} skipped as bad-candles: a price in the history, or a stored open, is unusable, so the open, high and low as of the slot cannot be known. By date, the row ids:`,
      ...byDateLines(badCandles),
    );
  }
  if (mismatched.size > 0) {
    lines.push(
      '',
      `WARNING: ${plural(total(mismatched), 'row')} with an open skipped as open-mismatch: the stored open is not the open as of its slot, so the row is not one this replay rebuilds, and nothing is written to it. By date, the row ids (both opens):`,
      ...byDateLines(mismatched),
    );
  }
  if (highLowLeft.size > 0) {
    lines.push(
      '',
      `WARNING: ${plural(total(highLowLeft), 'row')} with an open: high/low left as stored (bad candles); only the previous close and gap are planned. By date, the row ids:`,
      ...byDateLines(highLowLeft),
    );
  }
  const { widened } = replayedMoves(dates);
  if (widened.byDate.size > 0) {
    const [holds, its, written] =
      widened.rows === 1
        ? ['holds', 'its', 'It is']
        : ['hold', 'their', 'They are'];
    lines.push(
      '',
      `WARNING: ${plural(widened.rows, 'replayed row')} ${holds} a high below, or a low above, the value as of ${its} slot, though the replay read every bar that value uses: the candles changed since. ${written} written all the same, from today's candles. By date, the row ids:`,
      ...byDateLines(widened.byDate),
    );
  }
  return lines;
}

/** How a replayed row's high and low moved: rows, and each side. */
interface Moves {
  rows: number;
  high: number;
  low: number;
  byDate: Map<string, string[]>;
}

/**
 * Of the replayed rows that already had a high or a low, those whose stored
 * value is further out than the value as of the slot (narrowed: the peek the
 * replay took, through the bar that starts at the slot, removed) and those
 * whose stored value is nearer in (widened: a replay reads every bar the as-of
 * value uses, so the candles changed after it). Compared at 2 decimals, as
 * written. A NULL high or low is a fill, which is neither.
 */
function replayedMoves(dates: readonly DatePlan[]): {
  narrowed: Moves;
  widened: Moves;
} {
  const fresh = (): Moves => ({ rows: 0, high: 0, low: 0, byDate: new Map() });
  const narrowed = fresh();
  const widened = fresh();
  for (const d of dates) {
    for (const r of d.results) {
      if (r.kind !== 'update' || r.fill !== 'replayed') continue;
      const high = storedNumber(r.before.spx_high ?? null);
      const low = storedNumber(r.before.spx_low ?? null);
      const asHigh = Number(r.after.spx_high);
      const asLow = Number(r.after.spx_low);
      const highs = high == null ? 0 : Math.sign(high - asHigh);
      const lows = low == null ? 0 : Math.sign(asLow - low);
      // A stored high above the as-of high narrows; below it widens.
      for (const [moves, sign] of [
        [narrowed, 1],
        [widened, -1],
      ] as const) {
        const hit = [highs === sign, lows === sign];
        if (hit[0]) moves.high += 1;
        if (hit[1]) moves.low += 1;
        if (hit[0] || hit[1]) {
          moves.rows += 1;
          addTo(moves.byDate, d.date, r.id);
        }
      }
    }
  }
  return { narrowed, widened };
}

function narrowedLines(dates: readonly DatePlan[]): string[] {
  const { narrowed, widened } = replayedMoves(dates);
  return [
    `Replayed rows whose high or low narrowed: ${narrowed.rows} (high ${narrowed.high}, low ${narrowed.low})`,
    `Replayed rows whose high or low widened: ${widened.rows} (high ${widened.high}, low ${widened.low})`,
  ];
}

/**
 * Rows the run did not plan that still hold a previous close or a gap, which
 * it leaves as they are: those it left alone, and those on a date it skipped
 * whole, each by reason. A stored NaN is not a value.
 */
function staleLines(dates: readonly DatePlan[]): string[] {
  const rowLevel = new Map<string, number>();
  const onDates = new Map<string, number>();
  const bump = (counts: Map<string, number>, reason: string): void => {
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  };
  const holds = (row: SnapshotRowIn | undefined): boolean =>
    row != null &&
    (storedNumber(row.prev_close) != null ||
      storedNumber(row.overnight_gap) != null);
  for (const d of dates) {
    if (d.skippedDate != null) {
      const label = DATE_REASONS.find(([r]) => r === d.skippedDate)?.[1];
      for (const row of d.rows) {
        if (holds(row)) bump(onDates, label ?? d.skippedDate);
      }
      continue;
    }
    const byId = new Map(d.rows.map((r) => [r.id, r]));
    for (const r of d.results) {
      if (r.kind === 'skip' && r.reason !== 'unchanged') {
        if (holds(byId.get(r.id))) bump(rowLevel, r.reason);
      }
    }
  }
  const total = (counts: Map<string, number>): number =>
    [...counts.values()].reduce((n, c) => n + c, 0);
  return [
    `Rows left alone that hold a prev_close or gap: ${total(rowLevel)}${reasonList(
      LEFT_ALONE_REASONS.map(
        (name) => [name, rowLevel.get(name) ?? 0] as const,
      ),
    )}`,
    `Rows on skipped dates that hold a prev_close or gap: ${total(onDates)}${reasonList(
      DATE_REASONS.map(
        ([, label]) => [label, onDates.get(label) ?? 0] as const,
      ),
    )}`,
  ];
}

/** The entry labels the parser could not read, with counts. */
function labelLines(dates: readonly DatePlan[]): string[] {
  const counts = new Map<string, number>();
  for (const d of dates) {
    const byId = new Map(d.rows.map((r) => [r.id, r]));
    for (const r of d.results) {
      if (r.kind === 'skip' && r.reason === 'no-slot') {
        const label = byId.get(r.id)?.entry_time ?? '';
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    }
  }
  if (counts.size === 0) return ['Entry labels skipped as no-slot: none'];
  const entries = [...counts]
    .sort(([a, n], [b, m]) => m - n || (a < b ? -1 : a > b ? 1 : 0))
    .map(([label, n]) => `${JSON.stringify(label)} x ${n}`);
  return [`Entry labels skipped as no-slot: ${shownList(entries)}`];
}

function sampleLines(dates: readonly DatePlan[]): string[] {
  const lines = [
    'Samples for the hand check (the first and last of each kind):',
  ];
  for (const [fill, label] of FILL_LABELS) {
    const found = dates.flatMap((d) =>
      d.results.flatMap((r) => {
        const row = d.rows.find((x) => x.id === r.id);
        return r.kind === 'update' && r.fill === fill && row != null
          ? [{ row, update: r }]
          : [];
      }),
    );
    lines.push(`  ${label}:`);
    if (found.length === 0) lines.push('    (none)');
    for (const { row, update } of sampleOf(found)) {
      lines.push(describeSample(row, update));
    }
  }
  return lines;
}

/** The warnings a dry run ends with, before its last line. */
function warningLines(result: DryRunResult): string[] {
  const failed = result.dates.filter((d) => d.fetch === 'failed');
  const empty = failed.filter((d) => d.fetchDetail === EMPTY_HISTORY);
  const lines: string[] = [];
  if (failed.length > 0) {
    const them = failed.length === 1 ? 'it' : 'them';
    lines.push(
      '',
      `WARNING: ${plural(failed.length, 'date')} not planned because the history fetch failed (listed above). The exit code is 1. Re-run for ${them} with --since and --until.`,
    );
  }
  if (empty.length > 0) {
    const emptyOf = failed.length === 1 ? 'It' : `${empty.length} of them`;
    lines.push(
      `  ${emptyOf} came back empty. A re-run will not help for a date older than Schwab's 5-minute window; it may for a Schwab failure.`,
    );
  }
  if (result.untried.length > 0) {
    const detail = result.dates.at(-1)?.fetchDetail ?? '(no detail)';
    const verb = result.untried.length === 1 ? 'was' : 'were';
    lines.push(
      '',
      `WARNING: the fetch loop stopped after ${MAX_SAME_FAILURES} dates in a row failed with "${detail}"; ${plural(result.untried.length, 'date')} ${verb} never tried (their rows were not read): ${shownList(result.untried)}. The exit code is 1.`,
    );
  }
  return lines;
}

/** The printable summary of a dry run. */
export function formatReport(result: DryRunResult): string {
  const { dates } = result;
  const counts = countsOf(dates);
  const rec = reconcile(dates);
  const rowRef = (id: number | null): string =>
    id == null ? 'none' : `row ${id}`;
  const changes = dates.flatMap((d) =>
    d.pickChange == null
      ? []
      : [
          `  ${d.date}: ${rowRef(d.pickChange.from)} -> ${rowRef(d.pickChange.to)}`,
        ],
  );
  const planFile = fwd(result.planFile);
  const partlyRight =
    rec.partlyRight > 0
      ? ` + ${rec.partlyRight} right in previous close and gap only`
      : '';
  const lines = [
    'Snapshot price-context backfill: DRY RUN (writes nothing to the database)',
    `Range: ${result.since ?? 'the earliest date'} to ${result.until}`,
    `Read: ${plural(rec.read, 'row')} on ${plural(dates.length, 'date')}`,
    '',
    ...dateSkipLines(dates),
    '',
    ...crossCheckLines(dates),
    '',
    `Planned updates: ${counts.planned}`,
    ...FILL_LABELS.map(([fill, label]) => {
      const name = `${label}:`.padEnd(52);
      return `  ${name} ${counts.byFill[fill]}`;
    }),
    ...columnLines(dates),
    ...narrowedLines(dates),
    '',
    ...skipLines(dates),
    ...staleLines(dates),
    ...labelLines(dates),
    '',
    ...sampleLines(dates),
    '',
    changes.length === 0
      ? 'Dates whose feature snapshot pick changes: none'
      : `Dates whose feature snapshot pick changes (rebuild training_features for these only): ${changes.length}`,
    ...changes,
    '',
    `Reconciliation: ${plural(rec.read, 'row')} read = ${rec.planned} planned + ${rec.alreadyRight} already right${partlyRight} + ${rec.leftAlone} left alone + ${rec.onSkippedDates} on skipped dates`,
    'Dry run: nothing written to the database.',
    `Plan file: ${planFile}`,
    ...(counts.planned > 0
      ? [
          `To apply exactly this plan: npx tsx scripts/backfill-snapshot-price-context.ts --apply --plan ${planFile}`,
        ]
      : []),
    ...warningLines(result),
    '',
    summaryLine(dates, result.untried.length),
  ];
  return lines.join('\n');
}

/** The printable summary of an apply of a plan file, or of counting one. */
export function formatApplyReport(result: ApplyResult): string {
  const file = fwd(result.file);
  const range = `${result.since ?? 'the earliest date'} to ${result.until}`;
  const lines = [
    result.apply
      ? `Snapshot price-context backfill: APPLY of ${file}`
      : `Snapshot price-context backfill: the plan in ${file}`,
    `Plan made ${result.createdAt} against ${result.dbHost}, range ${range}`,
    `Dry run said: ${result.summary}`,
  ];
  if (!result.apply) {
    lines.push(
      `DRY RUN: nothing was written. Re-run with --apply --plan ${file} to write.`,
      `The plan holds ${plural(result.planned, 'row')}; nothing written.`,
    );
    return lines.join('\n');
  }
  if (result.undoFile == null) {
    lines.push('Nothing to write: the plan holds no updates.');
  } else {
    lines.push(`Undo file: ${fwd(result.undoFile)}`);
    if (result.reportFile != null) {
      lines.push(`Apply report: ${fwd(result.reportFile)}`);
    }
  }
  lines.push(
    `Rows planned: ${result.planned}`,
    `Rows written: ${result.written}`,
  );
  const already = result.alreadyAppliedIds;
  if (already.length > 0) {
    lines.push(
      `Rows already applied (they hold the plan's after values already): ${already.length}: ${shownList(already.map(String))}`,
    );
  }
  const left = result.unwrittenIds;
  if (left.length > 0) {
    const [it, were] = left.length === 1 ? ['it', 'was'] : ['they', 'were'];
    lines.push(
      `WARNING: ${plural(left.length, 'planned row')} ${were} not written: ${it} did not match the plan's before values, because ${it} changed since the dry run or ${were} already written by an earlier apply of this plan. Ids: ${shownList(left.map(String))}. The exit code is 1. Run a fresh dry run.`,
    );
  }
  if (result.checkError != null) {
    const [rows, they] =
      left.length === 1 ? ['row was', 'It is'] : ['rows were', 'They are'];
    lines.push(
      `WARNING: could not check whether the unwritten ${rows} already applied: ${result.checkError}. ${they} listed as not written.`,
    );
  }
  if (result.reportError != null) {
    lines.push(
      `WARNING: the apply report file could not be written: ${result.reportError}. The rows above were written and the undo file is complete. The exit code is 1.`,
    );
  }
  lines.push(
    `Planned ${plural(result.planned, 'row')}; written ${result.written}; already applied ${already.length}; not written ${left.length}.`,
  );
  return lines.join('\n');
}

export function formatUndoReport(result: UndoResult): string {
  const lines = [
    result.apply
      ? 'UNDO: old values were restored where a row still held the values the backfill wrote.'
      : 'DRY RUN: nothing was written. Re-run with --apply to restore.',
    `File: ${fwd(result.file)}`,
  ];
  if (!result.apply) {
    lines.push(`Rows in the file: ${result.rows}; nothing restored.`);
    return lines.join('\n');
  }
  lines.push(`Rows restored:    ${result.restored}`);
  if (result.changedIds.length > 0) {
    const [it, keeps] =
      result.changedIds.length === 1
        ? ['it', 'it keeps its value']
        : ['them', 'they keep their value'];
    lines.push(
      `WARNING: ${plural(result.changedIds.length, 'row')} no longer held the backfilled values (another writer changed ${it}, or the apply never wrote ${it}); ${keeps}: ${shownList(result.changedIds.map(String))}. The exit code is 1.`,
    );
  }
  lines.push(
    `Rows in the file: ${result.rows}; restored ${result.restored}; not restored ${result.changedIds.length}.`,
  );
  return lines.join('\n');
}
