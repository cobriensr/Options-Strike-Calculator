/**
 * netflow-time-grid — pure time-grid helpers for TickerNetFlowChart.
 *
 * Extracted from TickerNetFlowChart.tsx so the grid math can be
 * unit-tested directly (the component file only exports a component,
 * per react-refresh/only-export-components). These helpers are the
 * boundary where raw ISO tick timestamps become lightweight-charts
 * UTCTimestamps — and therefore where malformed timestamps must be
 * caught. One tick whose `ts` fails Date.parse would otherwise poison
 * the minute grid (NaN map key → NaN grid bounds → empty grid) and
 * silently wipe an entire previously-full chart.
 */

import type { UTCTimestamp } from 'lightweight-charts';
import { ctSessionBounds } from '../LotteryFinder/ct-window.js';

/** Local time-pinned alias — narrower than the library's Time union. */
export type Point = { time: UTCTimestamp; value: number };

/**
 * A drawn point or a whitespace point. lightweight-charts treats a data
 * item with no `value` as whitespace: it reserves a slot on the (index-
 * based) time scale without painting anything.
 */
export type FlowPoint = Point | { time: UTCTimestamp };

/** Grid cadence — one slot per minute across the whole session. */
export const SESSION_STEP_SEC = 60;

/**
 * Sanity-clamp slack around the session bounds. 24h is generous enough
 * for any legitimate tz/clock skew (real prints can only be hours off)
 * while capping the grid at ~3K slots even for a wildly mis-parsed time.
 */
const SESSION_CLAMP_SLACK_SEC = 24 * 3600;

/**
 * Parse an ISO timestamp to whole UTC seconds. Returns `null` when
 * `Date.parse` cannot produce a finite time — callers must drop (or
 * NaN-tag) such points rather than let NaN reach the grid math.
 */
export const isoToUtcSec = (iso: string): UTCTimestamp | null => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000) as UTCTimestamp;
};

/**
 * lightweight-charts shows duplicate-time points as outright errors
 * and silently drops monotonically-out-of-order points. Our net-flow
 * series can occasionally have two ticks at the same second (rare,
 * but possible when the daemon timestamps coincide); collapse them
 * by keeping the last value for each second.
 */
export function dedupAscending<T extends { time: UTCTimestamp; value: number }>(
  rows: T[],
): T[] {
  if (rows.length === 0) return rows;
  const out: T[] = [];
  let lastSec: UTCTimestamp | null = null;
  for (const r of rows) {
    if (lastSec != null && r.time === lastSec) {
      out[out.length - 1] = r;
      continue;
    }
    if (lastSec != null && r.time < lastSec) continue; // out-of-order; skip
    out.push(r);
    lastSec = r.time;
  }
  return out;
}

/**
 * Result of laying a series onto the session grid. `dropped` counts the
 * input points whose time was non-finite (malformed source timestamp) or
 * outside the session-range clamp — the component reports it to Sentry
 * so a field recurrence is a one-look diagnosis. `points` is empty only
 * when zero points survive the NaN + session-range filters; an input
 * with surviving points never grids to empty.
 */
export interface SessionGrid {
  points: FlowPoint[];
  dropped: number;
}

/**
 * Lay a value series onto a uniform one-point-per-minute grid spanning the
 * full 08:30→close CT session. Minutes with a tick carry that minute's last
 * cumulative value; empty minutes are whitespace (a `{time}`-only item that
 * reserves an axis slot without painting).
 *
 * Why a uniform grid (not just bracketing the data with whitespace at the
 * ends): lightweight-charts' time scale is index-based — a point's pixel
 * position is driven by its ORDINAL position, not its wall-clock time, and
 * `setVisibleRange` cannot extrapolate beyond the data. With a uniform
 * minute grid the logical index of any time is exactly its minute-offset
 * from the session open, so:
 *   - `setVisibleRange(open→close)` spans the full session even when the WS
 *     daemon has only indexed the last few minutes, and
 *   - the fixed-time fire marker maps to a STABLE coordinate regardless of
 *     how many (sub-minute, irregular) live ticks have arrived — the live
 *     feed is per-tick, so a non-uniform layout would let busy tickers
 *     drift the marker as point-count grew between polls.
 *
 * The grid extends past the session bounds only if real ticks fall outside
 * them (rare pre-open / post-close prints) so no data point is dropped.
 * No-op fallback to deduped raw points when `date` is absent (legacy/tests).
 *
 * NaN contract: input points with a non-finite `time` (a malformed source
 * `ts` the caller tagged as NaN) are dropped BEFORE bucketing and counted
 * in `dropped`. The grid is built from valid points only, so one poisoned
 * tick can never empty the grid. If the grid computation degenerates
 * anyway, the fallback is the plain deduped ascending valid points — never
 * `[]` while valid points exist.
 *
 * Range clamp: finite times outside [open − 24h, close + 24h] are dropped
 * and counted the same way — 24h is generous for any legitimate tz/clock
 * skew but caps grid size against finitely-mis-parsed timestamps (V8
 * reads 'garbage-1' as Jan 2001, which would inflate the grid to ~13M
 * points). Applies only when `date` yields usable session bounds.
 */
export function sessionMinuteGrid(
  points: Point[],
  date: string | undefined,
): SessionGrid {
  // Drop NaN-timed points FIRST — one NaN reaching the bucketing below
  // becomes a NaN map key, NaN grid bounds, and an empty grid (the
  // production blank-chart bug).
  const valid: Point[] = [];
  let dropped = 0;
  for (const p of points) {
    if (Number.isFinite(p.time as number)) valid.push(p);
    else dropped += 1;
  }
  if (valid.length === 0) return { points: [], dropped };
  if (date == null) return { points: dedupAscending(valid), dropped };
  const bounds = ctSessionBounds(date);
  const openSec = Math.floor(Date.parse(bounds.min) / 1000);
  const closeSec = Math.floor(Date.parse(bounds.max) / 1000);
  if (!Number.isFinite(openSec) || !Number.isFinite(closeSec)) {
    return { points: dedupAscending(valid), dropped };
  }

  // Sanity range clamp: a finite-but-absurd time (V8's lenient Date.parse
  // reads digit-bearing garbage like 'garbage-1' as Jan 2001) would widen
  // the minute grid to millions of points. Treat anything outside
  // [open − 24h, close + 24h] exactly like a non-finite time: drop + count.
  const rangeMin = openSec - SESSION_CLAMP_SLACK_SEC;
  const rangeMax = closeSec + SESSION_CLAMP_SLACK_SEC;
  const inRange: Point[] = [];
  for (const p of valid) {
    const t = p.time as number;
    if (t >= rangeMin && t <= rangeMax) inRange.push(p);
    else dropped += 1;
  }
  if (inRange.length === 0) return { points: [], dropped };

  // Bucket to the minute; the last cumulative value within a minute wins.
  // `points` is ts-ascending (API ORDER BY ts), so a later set() overwrites.
  const byMinute = new Map<number, number>();
  for (const p of inRange) {
    byMinute.set(Math.floor((p.time as number) / 60) * 60, p.value);
  }
  const minutes = [...byMinute.keys()];
  const gridStart = Math.min(openSec, ...minutes);
  const gridEnd = Math.max(closeSec, ...minutes);

  const out: FlowPoint[] = [];
  for (let t = gridStart; t <= gridEnd; t += SESSION_STEP_SEC) {
    const v = byMinute.get(t);
    out.push(
      v == null
        ? { time: t as UTCTimestamp }
        : { time: t as UTCTimestamp, value: v },
    );
  }
  // Defensive backstop: a non-empty valid input must never grid to empty.
  // All inputs above are finite so this shouldn't trigger, but if the
  // computation ever degenerates, plain deduped points beat a wiped chart.
  if (out.length === 0) return { points: dedupAscending(inRange), dropped };
  return { points: out, dropped };
}

/**
 * True when a raw tick `ts` would be DROPPED by sessionMinuteGrid for the
 * given grid date — either unparsable (Date.parse non-finite) or, when
 * `date` yields usable session bounds, outside the [open − 24h,
 * close + 24h] clamp window. This predicate owns the bounds math so the
 * component can pick a diagnostic SAMPLE raw string (for the Sentry
 * dropped-ticks message) without duplicating it. Mirrors the grid's
 * no-date behavior: without bounds, only the parse check applies.
 */
export function isDroppedTickTs(ts: string, date?: string): boolean {
  const t = isoToUtcSec(ts);
  if (t == null) return true;
  if (date == null) return false;
  const bounds = ctSessionBounds(date);
  const openSec = Math.floor(Date.parse(bounds.min) / 1000);
  const closeSec = Math.floor(Date.parse(bounds.max) / 1000);
  if (!Number.isFinite(openSec) || !Number.isFinite(closeSec)) return false;
  return (
    (t as number) < openSec - SESSION_CLAMP_SLACK_SEC ||
    (t as number) > closeSec + SESSION_CLAMP_SLACK_SEC
  );
}
