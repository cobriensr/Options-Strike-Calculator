/**
 * Attribution for the Phase 4 recompute (docs/superpowers/specs/
 * futures-contract-mix-repair-2026-11-06.md): which saved values were computed
 * from a bar that Phase 2 changed or deleted. Pure functions over the Phase 2
 * backup (the pre-repair rows) and the bars as they are now; nothing here
 * reads the database.
 *
 * A derived value is repair-affected when one of its input bars is in the
 * backup with a different value now, or is a bar Phase 2 deleted:
 *
 * - snapshot `price`: the latest closed bar's close;
 * - `change_1h_pct`: that bar, or the hour-ago bar's close;
 * - `change_day_pct`: that bar, or the day-open bar's close;
 * - `volume_ratio`: the volume of any bar in the 20-day window;
 * - the pre-market Globex numbers: the high, low, close or volume of any bar in
 *   the overnight window.
 *
 * The input bars are found with the rule `computeSnapshot` uses today
 * (api/_lib/futures-derive.ts), whose three constants are imported, not
 * copied. The rule itself is repeated here because computeSnapshot returns only
 * the latest bar's timestamp, so `inputsMatchSnapshot` checks that repeat
 * against what computeSnapshot returned.
 */

import { z } from 'zod';
import {
  BAR_CLOSE_LAG_MS,
  MAX_BAR_AGE_MS,
  VOLUME_WINDOW_MS,
} from '../../api/_lib/futures-derive.js';

const HOUR_MS = 60 * 60 * 1000;

export interface Bar {
  tsMs: number;
  /** Read from the table and the backup for the merge-state report; the attribution itself never uses it. */
  open?: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ── The Phase 2 backup ──────────────────────────────────────────────────────

const numeric = z
  .string()
  .refine((s) => Number.isFinite(Number(s)), 'not a number');

const backupLineSchema = z.object({
  op: z.enum(['update', 'delete']),
  row: z.object({
    symbol: z.string(),
    ts: z.string(),
    open: numeric.optional(),
    high: numeric,
    low: numeric,
    close: numeric,
    volume: numeric,
  }),
});

export interface BackupBar extends Bar {
  symbol: string;
  op: 'update' | 'delete';
}

/** Every line of a Phase 2 backup JSONL; a bad line throws with `label:line`. */
export function parseBackup(text: string, label: string): BackupBar[] {
  const out: BackupBar[] = [];
  text.split('\n').forEach((raw, i) => {
    if (raw.trim() === '') return;
    const where = `${label}:${i + 1}`;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `${where}: not JSON (${err instanceof Error ? err.message : String(err)})`,
        { cause: err },
      );
    }
    const parsed = backupLineSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        `${where}: ${issue?.path.join('.') ?? ''} ${issue?.message ?? 'invalid'}`.trim(),
      );
    }
    const { op, row } = parsed.data;
    const tsMs = Date.parse(row.ts);
    if (Number.isNaN(tsMs))
      throw new Error(`${where}: ts "${row.ts}" is not a date`);
    out.push({
      op,
      symbol: row.symbol,
      tsMs,
      open: row.open == null ? undefined : Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
    });
  });
  return out;
}

// ── Sorted-array helpers ────────────────────────────────────────────────────

/** First index in `sorted` whose value is >= `value`. */
function lowerBound(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] as number) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** True when `sorted` holds a value in [from, to]. */
function anyIn(sorted: readonly number[], from: number, to: number): boolean {
  if (to < from) return false;
  const i = lowerBound(sorted, from);
  return i < sorted.length && (sorted[i] as number) <= to;
}

function barLowerBound(bars: readonly Bar[], tsMs: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((bars[mid] as Bar).tsMs < tsMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The last bar with ts <= `tsMs` in a series sorted by ts, or null. */
export function lastAtOrBefore(bars: readonly Bar[], tsMs: number): Bar | null {
  const i = barLowerBound(bars, tsMs + 1);
  return i === 0 ? null : (bars[i - 1] as Bar);
}

/** The first bar with ts >= `tsMs` in a series sorted by ts, or null. */
export function firstAtOrAfter(bars: readonly Bar[], tsMs: number): Bar | null {
  return bars[barLowerBound(bars, tsMs)] ?? null;
}

// ── What Phase 2 changed ────────────────────────────────────────────────────

export interface Repair {
  /** Timestamps of the bars Phase 2 deleted, sorted. */
  deleted: number[];
  /** Timestamps whose close differs between the backup and the table now. */
  closeChanged: Set<number>;
  /** Timestamps whose volume differs now, plus the deleted bars, sorted. */
  volumeTouched: number[];
  /** Timestamps whose high, low, close or volume differs now, plus the deleted bars, sorted. */
  windowTouched: number[];
}

/**
 * One symbol's repair, from its backup rows and the bars as they are now. An
 * `update` row whose bar is gone counts as deleted.
 */
export function buildRepair(
  backup: readonly BackupBar[],
  current: ReadonlyMap<number, Bar>,
): Repair {
  const deleted: number[] = [];
  const closeChanged = new Set<number>();
  const volumeTouched: number[] = [];
  const windowTouched: number[] = [];
  for (const old of backup) {
    if (old.op === 'delete') {
      deleted.push(old.tsMs);
      volumeTouched.push(old.tsMs);
      windowTouched.push(old.tsMs);
      continue;
    }
    const now = current.get(old.tsMs);
    if (now == null) {
      // Updated by Phase 2 but gone now: as good as deleted.
      deleted.push(old.tsMs);
      closeChanged.add(old.tsMs);
      volumeTouched.push(old.tsMs);
      windowTouched.push(old.tsMs);
      continue;
    }
    const closeDiffers = now.close !== old.close;
    const volumeDiffers = now.volume !== old.volume;
    if (closeDiffers) closeChanged.add(old.tsMs);
    if (volumeDiffers) volumeTouched.push(old.tsMs);
    if (
      closeDiffers ||
      volumeDiffers ||
      now.high !== old.high ||
      now.low !== old.low
    ) {
      windowTouched.push(old.tsMs);
    }
  }
  const ascending = (a: number, b: number): number => a - b;
  deleted.sort(ascending);
  volumeTouched.sort(ascending);
  windowTouched.sort(ascending);
  return { deleted, closeChanged, volumeTouched, windowTouched };
}

// ── The old input, found by value ───────────────────────────────────────────

/**
 * How far back an old input is searched for by value. The April to June writer
 * had no freshness gate, so a frozen price can sit well behind the newest bar
 * (the junk bars Phase 2 deleted on Saturday 04-11 priced rows on Sunday
 * 04-12, 27 hours later).
 */
export const VALUE_LOOKBACK_MS = 96 * 60 * 60 * 1000;

/** A bar of the series as it was before Phase 2. */
export interface PreBar {
  tsMs: number;
  /** The close before Phase 2. */
  closePre: number;
  /** The close now; null for a deleted bar. */
  closeNow: number | null;
  /** What Phase 2 did to the bar's close: nothing, changed it, or deleted the bar. */
  repair: 'deleted' | 'close-changed' | null;
}

/**
 * One symbol's bars as they were before Phase 2: today's bars with each changed
 * bar's close put back, and the deleted bars put back. A bar the backup updated
 * that is gone now counts as deleted. Sorted by ts.
 */
export function buildPreSeries(
  backup: readonly BackupBar[],
  current: readonly Bar[],
): PreBar[] {
  const byTs = new Map<number, PreBar>(
    current.map((b) => [
      b.tsMs,
      { tsMs: b.tsMs, closePre: b.close, closeNow: b.close, repair: null },
    ]),
  );
  for (const old of backup) {
    const now = byTs.get(old.tsMs);
    const closeNow = now?.closeNow ?? null;
    let repair: PreBar['repair'] = null;
    if (closeNow == null) repair = 'deleted';
    else if (closeNow !== old.close) repair = 'close-changed';
    byTs.set(old.tsMs, {
      tsMs: old.tsMs,
      closePre: old.close,
      closeNow,
      repair,
    });
  }
  return [...byTs.values()].sort((a, b) => a.tsMs - b.tsMs);
}

/** Index of the last bar with ts <= `tsMs`, or -1. */
function lastIndexAtOrBefore(series: readonly PreBar[], tsMs: number): number {
  let lo = 0;
  let hi = series.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((series[mid] as PreBar).tsMs <= tsMs) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

export interface StoredSnapshot {
  price: number;
  change1hPct: number | null;
  changeDayPct: number | null;
}

export type ValueField = 'price' | 'change1hPct' | 'changeDayPct';

export interface ValueHit {
  field: ValueField;
  bar: PreBar;
}

export interface ValueRule {
  /** The fields a hit makes repair-affected (a price hit takes the 1h and day change with it). */
  fields: Set<SnapshotField>;
  /** The matched bars that Phase 2 deleted or changed. */
  hits: ValueHit[];
  /** The stored fields for which no pre-repair bar matched. */
  unmatched: ValueField[];
}

/** Half a tick is the most a NUMERIC(8,4) percentage can move a reconstructed close. */
const tolerance = (price: number): number => Math.abs(price) * 1e-6 + 0.00005;

/**
 * Finds a stored row's inputs by value in the pre-repair series. The ruling 1
 * rule looks for the input today's rule would pick, which misses an old input
 * that is older than today's: the writer used the newest bar it could see.
 *
 * - price: the newest bar at or before `atMs` whose pre-repair close equals the
 *   stored price, looking back at most VALUE_LOOKBACK_MS;
 * - hour-ago: the close reconstructed from the stored 1h change
 *   (P / (1 + pct / 100)), matched within a tolerance on the newest bar at or
 *   before `atMs - 60 min`;
 * - day-open: the same from the stored day change, on the oldest bar between the
 *   cash open and `atMs`.
 *
 * A matched bar that Phase 2 deleted or changed the close of makes the field
 * repair-affected. No match leaves the field alone and is counted.
 */
export function attributeByValue(
  series: readonly PreBar[],
  atMs: number,
  dayOpenMs: number | null,
  stored: StoredSnapshot,
): ValueRule {
  const out: ValueRule = { fields: new Set(), hits: [], unmatched: [] };
  const floor = atMs - VALUE_LOOKBACK_MS;
  const tol = tolerance(stored.price);

  const newest = (
    fromMs: number,
    matches: (b: PreBar) => boolean,
  ): PreBar | null => {
    for (let i = lastIndexAtOrBefore(series, fromMs); i >= 0; i -= 1) {
      const b = series[i] as PreBar;
      if (b.tsMs < floor) break;
      if (matches(b)) return b;
    }
    return null;
  };
  const note = (
    field: ValueField,
    bar: PreBar | null,
    fields: SnapshotField[],
  ): void => {
    if (bar == null) {
      out.unmatched.push(field);
      return;
    }
    if (bar.repair == null) return;
    out.hits.push({ field, bar });
    for (const f of fields) out.fields.add(f);
  };

  note(
    'price',
    newest(atMs, (b) => b.closePre === stored.price),
    ['price', 'change1hPct', 'changeDayPct'],
  );

  if (stored.change1hPct != null) {
    const hour = stored.price / (1 + stored.change1hPct / 100);
    note(
      'change1hPct',
      newest(atMs - HOUR_MS, (b) => Math.abs(b.closePre - hour) <= tol),
      ['change1hPct'],
    );
  }

  if (stored.changeDayPct != null && dayOpenMs != null) {
    const day = stored.price / (1 + stored.changeDayPct / 100);
    let found: PreBar | null = null;
    for (
      let i = lastIndexAtOrBefore(series, dayOpenMs - 1) + 1;
      i < series.length;
      i += 1
    ) {
      const b = series[i] as PreBar;
      if (b.tsMs > atMs) break;
      if (Math.abs(b.closePre - day) <= tol) {
        found = b;
        break;
      }
    }
    note('changeDayPct', found, ['changeDayPct']);
  }
  return out;
}

// ── Snapshot inputs ─────────────────────────────────────────────────────────

export interface SnapshotInputs {
  /** The latest bar closed by `at`, whatever its age. */
  latest: Bar | null;
  /** The hour-ago bar, when it is within MAX_BAR_AGE_MS of `at - 60 min`. */
  hourAgo: Bar | null;
  /** The day-open bar, when it printed within MAX_BAR_AGE_MS of the open and has closed. */
  dayOpen: Bar | null;
}

interface InputWindows {
  closedMs: number;
  hourMs: number;
  hourFloorMs: number;
  /** Upper bound for the day-open bar, or null when there is no cash session. */
  dayCeilMs: number | null;
}

function windows(atMs: number, dayOpenMs: number | null): InputWindows {
  const closedMs = atMs - BAR_CLOSE_LAG_MS;
  const hourMs = atMs - HOUR_MS;
  return {
    closedMs,
    hourMs,
    hourFloorMs: hourMs - MAX_BAR_AGE_MS,
    dayCeilMs:
      dayOpenMs == null ? null : Math.min(closedMs, dayOpenMs + MAX_BAR_AGE_MS),
  };
}

/** The bars `computeSnapshot` takes its price and references from, in today's rule. */
export function snapshotInputs(
  bars: readonly Bar[],
  atMs: number,
  dayOpenMs: number | null,
): SnapshotInputs {
  const w = windows(atMs, dayOpenMs);
  const hourAgo = lastAtOrBefore(bars, w.hourMs);
  const dayOpen = dayOpenMs == null ? null : firstAtOrAfter(bars, dayOpenMs);
  return {
    latest: lastAtOrBefore(bars, w.closedMs),
    hourAgo: hourAgo != null && hourAgo.tsMs >= w.hourFloorMs ? hourAgo : null,
    dayOpen:
      dayOpen != null && w.dayCeilMs != null && dayOpen.tsMs <= w.dayCeilMs
        ? dayOpen
        : null,
  };
}

export type SnapshotField =
  | 'price'
  | 'change1hPct'
  | 'changeDayPct'
  | 'volumeRatio';

/**
 * The saved fields of the snapshot at `atMs` that were computed from a bar
 * Phase 2 changed or deleted. A bar deleted between an input and its bound is
 * an input that no longer exists: it would have been the old latest, hour-ago
 * or day-open bar.
 */
export function affectedSnapshotFields(
  repair: Repair,
  bars: readonly Bar[],
  atMs: number,
  dayOpenMs: number | null,
): Set<SnapshotField> {
  const w = windows(atMs, dayOpenMs);
  const inputs = snapshotInputs(bars, atMs, dayOpenMs);
  const out = new Set<SnapshotField>();

  const latest = inputs.latest;
  const priceHit =
    latest != null &&
    (repair.closeChanged.has(latest.tsMs) ||
      anyIn(repair.deleted, latest.tsMs + 1, w.closedMs));
  if (priceHit) out.add('price');

  const hourRaw = lastAtOrBefore(bars, w.hourMs);
  const hourHit =
    (inputs.hourAgo != null && repair.closeChanged.has(inputs.hourAgo.tsMs)) ||
    anyIn(
      repair.deleted,
      Math.max(hourRaw?.tsMs ?? Number.NEGATIVE_INFINITY, w.hourFloorMs - 1) +
        1,
      w.hourMs,
    );
  if (priceHit || hourHit) out.add('change1hPct');

  if (dayOpenMs != null && w.dayCeilMs != null) {
    const dayRaw = firstAtOrAfter(bars, dayOpenMs);
    const dayHit =
      (inputs.dayOpen != null &&
        repair.closeChanged.has(inputs.dayOpen.tsMs)) ||
      anyIn(
        repair.deleted,
        dayOpenMs,
        Math.min(w.dayCeilMs, (dayRaw?.tsMs ?? Number.POSITIVE_INFINITY) - 1),
      );
    if (priceHit || dayHit) out.add('changeDayPct');
  } else if (priceHit) {
    out.add('changeDayPct');
  }

  if (anyIn(repair.volumeTouched, atMs - VOLUME_WINDOW_MS, w.closedMs)) {
    out.add('volumeRatio');
  }
  return out;
}

export interface SnapshotValuesLike {
  price: number;
  change1hPct: number | null;
  changeDayPct: number | null;
  latestTs: string;
}

const pctOf = (price: number, ref: Bar | null): number | null =>
  ref != null && ref.close !== 0
    ? Math.max(-999, Math.min(999, ((price - ref.close) / ref.close) * 100))
    : null;

const closeEnough = (a: number | null, b: number | null): boolean =>
  a == null || b == null ? a === b : Math.abs(a - b) < 1e-9;

/**
 * True when the inputs found here are the bars `computeSnapshot` used: the same
 * latest bar, and the 1h and day changes it returned follow from the hour-ago
 * and day-open bars found here. A mirrored rule that drifted from
 * computeSnapshot shows up as false.
 */
export function inputsMatchSnapshot(
  inputs: SnapshotInputs,
  snapshot: SnapshotValuesLike,
): boolean {
  if (inputs.latest == null) return false;
  return (
    inputs.latest.tsMs === Date.parse(snapshot.latestTs) &&
    inputs.latest.close === snapshot.price &&
    closeEnough(pctOf(snapshot.price, inputs.hourAgo), snapshot.change1hPct) &&
    closeEnough(pctOf(snapshot.price, inputs.dayOpen), snapshot.changeDayPct)
  );
}

// ── Pre-market windows ──────────────────────────────────────────────────────

/** True when Phase 2 changed or deleted a bar with `fromMs <= ts < toMs`. */
export function windowAffected(
  repair: Repair,
  fromMs: number,
  toMs: number,
): boolean {
  return anyIn(repair.windowTouched, fromMs, toMs - 1);
}

export interface WindowAggregate {
  high: number;
  low: number;
  close: number;
  vwap: number | null;
}

/** The cron's Globex aggregate over bars sorted by ts; null for no bars. */
export function aggregateWindow(bars: readonly Bar[]): WindowAggregate | null {
  const last = bars.at(-1);
  if (last == null) return null;
  let notional = 0;
  let volume = 0;
  for (const b of bars) {
    notional += b.close * b.volume;
    volume += b.volume;
  }
  return {
    high: Math.max(...bars.map((b) => b.high)),
    low: Math.min(...bars.map((b) => b.low)),
    close: last.close,
    vwap: volume > 0 ? notional / volume : null,
  };
}

/**
 * The bars of a window as they were before Phase 2: the bars now, with each
 * backed-up `update` row put back and each deleted row added back.
 */
export function preRepairWindow(
  now: readonly Bar[],
  backup: readonly BackupBar[],
  fromMs: number,
  toMs: number,
): Bar[] {
  const byTs = new Map<number, Bar>(now.map((b) => [b.tsMs, b]));
  for (const old of backup) {
    if (old.tsMs < fromMs || old.tsMs >= toMs) continue;
    byTs.set(old.tsMs, {
      tsMs: old.tsMs,
      high: old.high,
      low: old.low,
      close: old.close,
      volume: old.volume,
    });
  }
  return [...byTs.values()].sort((a, b) => a.tsMs - b.tsMs);
}

// ── Why a clean-era-looking snapshot row does not match ─────────────────────

/** The 2026-09 outage of the futures bars: 09-03 to 09-29, another session backfilled it later. */
export const SEPTEMBER_GAP_FROM_MS = Date.UTC(2026, 8, 3);
/** Exclusive: the gap's last day is 09-29. */
export const SEPTEMBER_GAP_TO_MS = Date.UTC(2026, 8, 30);
/** A late bar's stored price is the close of a bar this many minutes older than today's latest closed bar, at most. */
export const LATE_BAR_MAX_AGE_MIN = 14;

export type MismatchClass = 'september-window' | 'late-bar' | 'unexplained';

export interface OlderBar {
  /** Minutes older than today's latest closed bar. */
  ageMin: number;
  close: number;
}

/**
 * One class for a snapshot row whose recompute differs from what is stored,
 * checked in this order:
 *
 * - `september-window`: only the volume ratio differs and the row's 20-day
 *   window overlaps the September outage, whose bars were filled in later;
 * - `late-bar`: the stored price differs from today's latest closed bar's
 *   close and is the close of a closed bar 1 to 14 minutes older, which is what
 *   the cron saw while the newer bars had not landed yet (`olderBars`, newest
 *   first; the newest match gives the age). The row's other differences follow
 *   from that. A price that already equals the latest close is not explained
 *   by a late bar, even when an older bar closed at the same price, so such a
 *   row stays unexplained and `olderMatch` says an older bar matched;
 * - `unexplained`: anything else.
 */
export function classifyMismatch(row: {
  fields: readonly SnapshotField[];
  atMs: number;
  storedPrice: number;
  olderBars: readonly OlderBar[];
}): { cls: MismatchClass; ageMin: number | null; olderMatch: boolean } {
  const onlyVolumeRatio =
    row.fields.length === 1 && row.fields[0] === 'volumeRatio';
  const windowOverlapsGap =
    row.atMs >= SEPTEMBER_GAP_FROM_MS &&
    row.atMs - VOLUME_WINDOW_MS < SEPTEMBER_GAP_TO_MS;
  if (onlyVolumeRatio && windowOverlapsGap) {
    return { cls: 'september-window', ageMin: null, olderMatch: false };
  }
  const late = row.olderBars.find(
    (b) =>
      b.ageMin >= 1 &&
      b.ageMin <= LATE_BAR_MAX_AGE_MIN &&
      b.close === row.storedPrice,
  );
  const olderMatch = late != null;
  if (late != null && row.fields.includes('price')) {
    return { cls: 'late-bar', ageMin: late.ageMin, olderMatch };
  }
  return { cls: 'unexplained', ageMin: null, olderMatch };
}

export type ThinMissClass = 'late-bar' | 'late-volume' | 'other';

/** One unit of the NUMERIC(8,4) volume_ratio column. */
const VOLUME_RATIO_UNIT = 0.0001;

/**
 * The class of a miss in the method control of a thin root (RTY, CL, GC, ZN),
 * whose minute bar can land after the cron read. A late bar can only do two
 * things to what the cron saw: leave the price on an older bar, or leave out a
 * volume. The first is `late-bar` (see classifyMismatch). The second is
 * `late-volume`: the price, 1h and day change all match and the volume ratio
 * moved by a late fill.
 *
 * - A bar filled in later today raises today's total by `v` and the 20-day
 *   average, a sum that already holds today, by at most `v / n`: the ratio goes
 *   up, so the stored ratio is below the recomputed one.
 * - A hole filled in later on a prior day raises the average and lowers the
 *   ratio (backfill-futures-gaps does this after the close). That can flip the
 *   fourth decimal by rounding, so a stored ratio above the recomputed one by
 *   at most one unit of the column also counts.
 *
 * A stored ratio above by more than that, a null on either side, or any other
 * field is `other`: a method difference, not an arrival.
 */
export function classifyThinMiss(row: {
  fields: readonly SnapshotField[];
  atMs: number;
  storedPrice: number;
  olderBars: readonly OlderBar[];
  storedVolumeRatio: number | null;
  recomputedVolumeRatio: number | null;
}): { cls: ThinMissClass; ageMin: number | null } {
  const late = classifyMismatch(row);
  if (late.cls === 'late-bar') return { cls: 'late-bar', ageMin: late.ageMin };
  const onlyVolumeRatio =
    row.fields.length === 1 && row.fields[0] === 'volumeRatio';
  if (
    onlyVolumeRatio &&
    row.storedVolumeRatio != null &&
    row.recomputedVolumeRatio != null &&
    Math.round(
      (row.storedVolumeRatio - row.recomputedVolumeRatio) / VOLUME_RATIO_UNIT,
    ) <= 1
  ) {
    return { cls: 'late-volume', ageMin: null };
  }
  return { cls: 'other', ageMin: null };
}

// ── The merge state of a bar the cron read ──────────────────────────────────

export interface OhlcView {
  open: number | null;
  high: number;
  low: number;
  close: number;
}

/** A bar near a row's latest closed bar, with what Phase 2 did to it. */
export interface MergeBarView {
  tsMs: number;
  /** Minutes older than the latest closed bar; 0 for that bar. */
  ageMin: number;
  /** The bar as it was before Phase 2; null when Phase 2 did not update it. */
  pre: OhlcView | null;
  now: OhlcView;
  /** Phase 2 changed a value of this bar. */
  changed: boolean;
}

/**
 * The latest closed bar `latest` and every bar up to LATE_BAR_MAX_AGE_MIN
 * minutes older, newest first, each with its pre-repair values when the Phase 2
 * backup updated it. `bars` is sorted by ts and holds `latest`.
 */
export function mergeStateBars(
  bars: readonly Bar[],
  updates: ReadonlyMap<number, BackupBar>,
  latest: Bar,
): MergeBarView[] {
  const out: MergeBarView[] = [];
  const start = Math.min(barLowerBound(bars, latest.tsMs), bars.length - 1);
  for (let i = start; i >= 0; i -= 1) {
    const b = bars[i] as Bar;
    if (b.tsMs > latest.tsMs) continue;
    if (latest.tsMs - b.tsMs > LATE_BAR_MAX_AGE_MIN * 60_000) break;
    const u = updates.get(b.tsMs);
    out.push({
      tsMs: b.tsMs,
      ageMin: Math.round((latest.tsMs - b.tsMs) / 60_000),
      pre:
        u == null
          ? null
          : { open: u.open ?? null, high: u.high, low: u.low, close: u.close },
      now: { open: b.open ?? null, high: b.high, low: b.low, close: b.close },
      changed:
        u != null &&
        (u.high !== b.high ||
          u.low !== b.low ||
          u.close !== b.close ||
          u.volume !== b.volume ||
          (u.open != null && b.open != null && u.open !== b.open)),
    });
  }
  return out;
}

/**
 * The newest bar in `views` that Phase 2 changed, whose pre-repair [low, high]
 * holds `price` and whose current [low, high] does not: a cron that read the
 * bar while contract months were still merged into it (the Databento-era upsert
 * kept high = GREATEST, low = LEAST, close = last write) could store a price
 * that lies in the merged range and matches no final bar. Null when none.
 */
export function findMergeState(
  views: readonly MergeBarView[],
  price: number,
): MergeBarView | null {
  return (
    views.find(
      (v) =>
        v.changed &&
        v.pre != null &&
        v.pre.low <= price &&
        price <= v.pre.high &&
        !(v.now.low <= price && price <= v.now.high),
    ) ?? null
  );
}
