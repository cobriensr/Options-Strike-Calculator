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
 * (api/_lib/futures-derive.ts). The rule is mirrored here because
 * computeSnapshot returns only the latest bar's timestamp, so
 * `inputsMatchSnapshot` checks the mirror against what computeSnapshot returned.
 */

import { z } from 'zod';

// ── The snapshot rule, mirrored from api/_lib/futures-derive.ts ─────────────

/** Oldest a bar may be and still stand in for a moment (MAX_BAR_AGE_MS there). */
export const MAX_BAR_AGE_MS = 15 * 60 * 1000;
/** A bar is visible only once its minute has closed (BAR_CLOSE_LAG_MS there). */
export const BAR_CLOSE_LAG_MS = 60 * 1000;
/** The volume baseline reaches back this far. */
export const VOLUME_WINDOW_MS = 20 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface Bar {
  tsMs: number;
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
 * `update` row whose bar is gone counts as changed in every field.
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
