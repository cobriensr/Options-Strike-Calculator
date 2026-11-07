/**
 * Closed 5-minute buckets from UW's per-minute cumulative tide grids.
 *
 * Shared by fetch-etf-tide (/market/{ticker}/etf-tide) and fetch-zero-dte-flow
 * (/net-flow/expiry). Both send the whole session's grid on every call. From
 * about 09:32 ET it holds one row per minute with null values for the minutes
 * that have not happened yet, and before the roll-over (09:28-09:32 ET) it
 * holds the PREVIOUS session. The crons used to turn a null into 0 (or store
 * NULL), and `ON CONFLICT DO NOTHING` then kept that first write for the day.
 * Spec: docs/superpowers/specs/live-data-integrity-2026-11-06.md (F1-F3).
 *
 * The rules this module applies, in the spec's names:
 *   - R-day:    only rows whose own timestamp is on today's ET date and at or
 *               after the 09:30 ET open. A payload with none (the pre-open
 *               answer) yields `sessionRows: 0`, and the caller stores nothing.
 *   - R-null:   a bucket's value is its LAST minute's value. When that value
 *               is missing or unparseable the bucket is left out and counted,
 *               never stored as 0 or NULL. An earlier minute is never
 *               substituted: the last minute may only be late, and a
 *               substitute would then freeze under DO NOTHING.
 *   - R-closed: a bucket is returned only once it has closed (end <= now).
 *               Its last minute has then ended, so the value is final and
 *               DO NOTHING keeps the right one.
 *   - Label rule (spec open question 1, default in force): the final value of
 *               a closed bucket is stored under the bucket's END time. The
 *               09:30-09:35 bucket is stored at 09:35, the time its value is
 *               as of. See `labelMs`: answering "window start" is a one-line
 *               change there.
 *
 * Pure: the caller passes `now`, read once before it fetched, so every bucket
 * called closed was already closed when UW answered.
 */

import { MARKET_MINUTES } from './constants.js';
import {
  getETCloseUtcIso,
  getETDateStr,
  getETMarketOpenUtcIso,
  getETTotalMinutes,
} from '../../src/utils/timezone.js';

export const BUCKET_MS = 5 * 60_000;
const MINUTE_MS = 60_000;

/** One UW minute row. Each value may be null, absent or garbled. */
export interface TideMinute {
  timestamp: string;
  net_call_premium: unknown;
  net_put_premium: unknown;
  net_volume: unknown;
}

/** A closed bucket's final values, ready for flow_data. */
export interface ClosedBucket {
  /** ISO instant the row is stored under (see the label rule). */
  timestamp: string;
  ncp: number;
  npp: number;
  netVolume: number;
}

export interface ClosedBucketsResult {
  /** Closed buckets with a usable last minute, oldest first. */
  buckets: ClosedBucket[];
  /**
   * Rows of the payload on today's ET session. 0 means UW sent nothing for
   * today (the pre-open answer holding the previous session, or no rows).
   */
  sessionRows: number;
  /**
   * Closed buckets left out because their last minute has no usable value.
   * Counted again on every run until UW fills the minute, so it reads as
   * "buckets this run could not store", not as an event count.
   */
  unusable: number;
}

/**
 * The time a closed bucket is stored under, from its start. Label rule:
 * the bucket's END (spec open question 1, default). If the owner answers
 * "window start", return `bucketStartMs`.
 */
function labelMs(bucketStartMs: number): number {
  return bucketStartMs + BUCKET_MS;
}

/** A finite number from a number or numeric string, else null. UW sends decimals as strings. */
function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function closedBuckets(
  rows: readonly TideMinute[],
  now: Date,
): ClosedBucketsResult {
  const today = getETDateStr(now);
  const nowMs = now.getTime();

  // R-day: today's ET session rows only, oldest first (UW promises no order).
  const session: Array<{ ms: number; row: TideMinute }> = [];
  for (const row of rows) {
    const ms = Date.parse(row.timestamp);
    if (!Number.isFinite(ms)) continue;
    const when = new Date(ms);
    if (getETDateStr(when) !== today) continue;
    if (getETTotalMinutes(when) < MARKET_MINUTES.OPEN) continue;
    session.push({ ms, row });
  }
  session.sort((a, b) => a.ms - b.ms);

  // The latest row of each bucket. ET offsets are whole hours, so epoch-aligned
  // 5-minute windows are the ET-aligned ones.
  const lastOfBucket = new Map<number, { ms: number; row: TideMinute }>();
  for (const entry of session) {
    lastOfBucket.set(Math.floor(entry.ms / BUCKET_MS) * BUCKET_MS, entry);
  }

  const buckets: ClosedBucket[] = [];
  let unusable = 0;
  // Map order is insertion order, and `session` is sorted: oldest bucket first.
  for (const [startMs, last] of lastOfBucket) {
    const endMs = startMs + BUCKET_MS;
    if (endMs > nowMs) continue; // R-closed: still open, store it on a later run.

    const ncp = finiteNumber(last.row.net_call_premium);
    const npp = finiteNumber(last.row.net_put_premium);
    const netVolume = finiteNumber(last.row.net_volume);
    // R-null: the bucket's value is its last minute's, so that minute's row
    // must be there (not an earlier one) and carry all three values.
    const hasLastMinute = last.ms >= endMs - MINUTE_MS;
    if (!hasLastMinute || ncp === null || npp === null || netVolume === null) {
      unusable++;
      continue;
    }
    buckets.push({
      timestamp: new Date(labelMs(startMs)).toISOString(),
      ncp,
      npp,
      netVolume,
    });
  }
  return { buckets, sessionRows: session.length, unusable };
}

/**
 * The UTC instants of 09:30 ET and 16:00 ET on ET day `day`, for the crons'
 * data-quality queries (R-quality): count only rows stamped on today's
 * session, so the previous session's rows cannot hide a dead day. The bounds
 * are computed here, not in SQL, to avoid the `date AT TIME ZONE` pitfall.
 */
export function sessionWindowIso(day: string): {
  openIso: string;
  closeIso: string;
} {
  const openIso = getETMarketOpenUtcIso(day);
  const closeIso = getETCloseUtcIso(day);
  if (openIso === null || closeIso === null) {
    throw new Error(`sessionWindowIso: malformed ET date "${day}"`);
  }
  return { openIso, closeIso };
}
