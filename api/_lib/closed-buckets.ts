/**
 * Closed 5-minute buckets from UW's per-minute grids.
 *
 * Shared by fetch-etf-tide (/market/{ticker}/etf-tide) and fetch-zero-dte-flow
 * (/net-flow/expiry), which send the whole session's grid on every call: 390
 * one-minute rows, 09:30-15:59 ET (measured 2026-11-06). From about 09:32 ET
 * the minutes that have not happened yet carry null values, and before the
 * roll-over (09:28-09:32 ET) the answer holds the PREVIOUS session. The crons
 * used to turn a null into 0 (or store NULL), and `ON CONFLICT DO NOTHING`
 * then kept that first write for the day.
 * Spec: docs/superpowers/specs/live-data-integrity-2026-11-06.md (F1-F3).
 *
 * Also shared by fetch-greek-flow (/stock/SPX/greek-flow/{expiry}, F4): one
 * row a minute of per-minute delta flows, which holds the PREVIOUS session's
 * trades (1DTE flow) before the roll-over and minutes after the cash close
 * (SPX options print until 16:15 ET).
 *
 * `closedBucketsOf` holds the rules below once. A source brings only its
 * per-row value parse (`tideValues`, `greekFlowValues`): the wrappers
 * `closedBuckets` and `closedGreekFlowBuckets` bind them.
 *
 * The rules this module applies, in the spec's names:
 *   - R-day:    only rows whose own timestamp is on today's ET date, at or
 *               after the 09:30 ET open and before the close (16:00 ET, or
 *               13:00 ET on an early-close day). A payload with none (the
 *               pre-open answer) yields `sessionRows: 0`, and the caller
 *               stores nothing.
 *   - R-null:   a bucket's value is its LAST minute's value. When that value
 *               is missing, unparseable or outside the column's range the
 *               bucket is left out, never stored as 0 or NULL, and an earlier
 *               minute is never substituted: the last minute may only be
 *               late, and a substitute would then be stored in its place. An
 *               absent `net_volume` (`volume` for greek flow) is the one
 *               exception: it is stored as NULL, as the backfill does.
 *   - R-closed: a bucket is returned only once its end passed FINAL_LAG_MS
 *               ago. A minute that has ended is not necessarily final, so the
 *               crons also upsert (flow-bucket-store.ts): a value UW revises
 *               later is healed by the next run.
 *   - Label rule (spec open question 1, default in force): the final value of
 *               a closed bucket is stored under the bucket's END time. The
 *               09:30-09:35 bucket is stored at 09:35, the time its value is
 *               as of. See `labelMs`: answering "window start" is a one-line
 *               change there.
 *
 * An unusable closed bucket is `pending` while it ended less than
 * STUCK_AFTER_MS ago (UW is late: expected) and `stuck` after that, or once
 * the tide crons' last attempt of the day has come (LAST_ATTEMPT_AFTER_CLOSE_MS
 * after the close).
 *
 * Pure: the caller passes `now`, read once before it fetched, so every bucket
 * called closed was already closed when UW answered.
 */

import { MARKET_MINUTES } from './constants.js';
import { getMarketCloseHourET } from '../../src/data/marketHours.js';
import {
  etWallClockToUtcIso,
  getETDateStr,
  getETMarketOpenUtcIso,
  getETTotalMinutes,
} from '../../src/utils/timezone.js';

export const BUCKET_MS = 5 * 60_000;
const MINUTE_MS = 60_000;

/**
 * Operational margin, not a guarantee: a bucket is stored only once its end
 * is this far behind `now`. UW fills a minute's value after the minute ends,
 * and the crons run 2 (ETF) and 4 (zero-DTE) minutes after a bucket closes.
 * A value revised later is still healed by the upsert.
 */
export const FINAL_LAG_MS = 90_000;

/**
 * An unusable closed bucket older than this is `stuck`: UW is not just late.
 * A shorter one is `pending`, which is expected and not reported.
 */
export const STUCK_AFTER_MS = 10 * 60_000;

/**
 * From this long after the session close every unusable bucket is `stuck`,
 * whatever its age. The tide crons' last runs are 16:07 (fetch-etf-tide) and
 * 16:09 (fetch-zero-dte-flow), 7 and 9 minutes after the final bucket ends:
 * by the age rule alone a late 15:59 minute would stay `pending` and silent
 * and the day's last row would be lost without a word. Their first attempts
 * (close + 2 and + 4) are before this, so a minute that is only late there is
 * still `pending`.
 */
export const LAST_ATTEMPT_AFTER_CLOSE_MS = 5 * 60_000;

/** The feed counts as stalled when there are no rows for today from 09:40 ET. */
const STALL_FROM_ET_MINUTES = 9 * 60 + 40;

/**
 * flow_data's column ranges (migrations #4 and #48): net_volume is INTEGER;
 * ncp and npp are DECIMAL(14,2), 12 digits before the point, so 100 times the
 * value rounded to a cent is at most 99_999_999_999_999. A value outside its
 * range makes Postgres reject the whole multi-row INSERT. Same limits as
 * scripts/_lib/flow-data-backfill.mjs (fitsInteger, fitsDecimal).
 */
const INT4_MIN = -2_147_483_648;
const INT4_MAX = 2_147_483_647;
const DECIMAL_14_2_MAX_CENTS = 99_999_999_999_999;

const fitsInteger = (n: number): boolean => n >= INT4_MIN && n <= INT4_MAX;
const fitsDecimal = (n: number): boolean =>
  Math.round(Math.abs(n) * 100) <= DECIMAL_14_2_MAX_CENTS;

/** One UW tide minute row. Each value may be null, absent or garbled. */
export interface TideMinute {
  timestamp: string;
  net_call_premium: unknown;
  net_put_premium: unknown;
  net_volume: unknown;
}

/**
 * One UW greek-flow minute row (the fields fetch-greek-flow maps). Each value
 * may be null, absent or garbled.
 */
export interface GreekFlowMinute {
  timestamp: string;
  total_delta_flow: unknown;
  dir_delta_flow: unknown;
  otm_total_delta_flow: unknown;
  otm_dir_delta_flow: unknown;
  volume: unknown;
}

/** The values a source stores for a bucket, parsed from its last minute row. */
export interface BucketValues {
  ncp: number;
  npp: number;
  /** NULL when UW sent no volume for the bucket's last minute. */
  netVolume: number | null;
  /**
   * The OTM wings (flow_data otm_ncp, otm_npp), for a source that has them
   * (greek flow). Absent for the tide sources, whose rows leave the two
   * columns NULL.
   */
  otm?: { ncp: number; npp: number };
}

/** A closed bucket's final values, ready for flow_data. */
export interface ClosedBucket extends BucketValues {
  /** ISO instant the row is stored under (see the label rule). */
  timestamp: string;
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
   * Closed buckets left out because their last minute has no usable value and
   * UW may still be late: the bucket ended less than STUCK_AFTER_MS ago and,
   * for the final bucket of the day, the day's last attempt (the session
   * close + LAST_ATTEMPT_AFTER_CLOSE_MS) has not come yet. Expected, not
   * reported.
   */
  pending: number;
  /**
   * The same, but UW is no longer just late: the bucket ended STUCK_AFTER_MS
   * or more ago, or it is the final bucket and the day's last attempt has
   * come. Counted on every run.
   */
  stuck: number;
  /** Row timestamp the oldest stuck bucket would be stored under, or null. */
  oldestStuck: string | null;
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

/**
 * ET minute of day the session ends at on ET day `day`: 16:00, or 13:00 on
 * an early-close day. A closed day (forced run) gets the regular 16:00.
 */
function sessionCloseMinutes(day: string): number {
  const closeHour = getMarketCloseHourET(day);
  return closeHour === null ? MARKET_MINUTES.CLOSE : closeHour * 60;
}

/** A number that fits DECIMAL(14,2), else null (missing, garbled or out of range). */
function decimalValue(raw: unknown): number | null {
  const n = finiteNumber(raw);
  return n !== null && fitsDecimal(n) ? n : null;
}

/**
 * A volume column's value. An absent one (null or undefined) is `{ value:
 * null }`, stored as NULL as the backfill does. One that is present must be a
 * safe integer inside INTEGER, else null (unusable).
 */
function volumeValue(raw: unknown): { value: number | null } | null {
  if (raw == null) return { value: null };
  const n = finiteNumber(raw);
  if (n === null || !Number.isSafeInteger(n) || !fitsInteger(n)) return null;
  return { value: n };
}

/**
 * A tide minute row's values for flow_data, or null when it cannot be stored
 * as it is: a premium that is not a number or outside DECIMAL(14,2), or a
 * `net_volume` that is present but not a safe integer inside INTEGER. An
 * absent `net_volume` is NULL, as the backfill stores it.
 */
function tideValues(row: TideMinute): BucketValues | null {
  const ncp = decimalValue(row.net_call_premium);
  const npp = decimalValue(row.net_put_premium);
  const volume = volumeValue(row.net_volume);
  if (ncp === null || npp === null || volume === null) return null;
  return { ncp, npp, netVolume: volume.value };
}

/**
 * A greek-flow minute row's values for flow_data, or null when it cannot be
 * stored as it is: ncp = total_delta_flow, npp = dir_delta_flow, otm_ncp =
 * otm_total_delta_flow and otm_npp = otm_dir_delta_flow must all be numbers
 * inside DECIMAL(14,2) (a missing wing is not stored as NULL or 0: the bucket
 * waits for UW). net_volume = volume follows the tide rule: absent is NULL,
 * present must be a safe integer inside INTEGER.
 */
function greekFlowValues(row: GreekFlowMinute): BucketValues | null {
  const ncp = decimalValue(row.total_delta_flow);
  const npp = decimalValue(row.dir_delta_flow);
  const otmNcp = decimalValue(row.otm_total_delta_flow);
  const otmNpp = decimalValue(row.otm_dir_delta_flow);
  const volume = volumeValue(row.volume);
  if (
    ncp === null ||
    npp === null ||
    otmNcp === null ||
    otmNpp === null ||
    volume === null
  ) {
    return null;
  }
  return {
    ncp,
    npp,
    netVolume: volume.value,
    otm: { ncp: otmNcp, npp: otmNpp },
  };
}

/** Closed buckets of a tide payload (fetch-etf-tide, fetch-zero-dte-flow). */
export function closedBuckets(
  rows: readonly TideMinute[],
  now: Date,
): ClosedBucketsResult {
  return closedBucketsOf(rows, now, tideValues);
}

/** Closed buckets of a greek-flow payload (fetch-greek-flow). */
export function closedGreekFlowBuckets(
  rows: readonly GreekFlowMinute[],
  now: Date,
): ClosedBucketsResult {
  return closedBucketsOf(rows, now, greekFlowValues);
}

/**
 * The session, closure, pending and stuck rules for any per-minute source.
 * `parseValues` turns a row into the values to store, or null when the row
 * cannot be stored as it is (R-null); it is asked only for the last minute of
 * a bucket that has closed.
 */
export function closedBucketsOf<Row extends { timestamp: string }>(
  rows: readonly Row[],
  now: Date,
  parseValues: (row: Row) => BucketValues | null,
): ClosedBucketsResult {
  const today = getETDateStr(now);
  const nowMs = now.getTime();
  const closeMinutes = sessionCloseMinutes(today);

  // R-day: today's ET session rows only, oldest first (UW promises no order).
  const session: Array<{ ms: number; row: Row }> = [];
  for (const row of rows) {
    const ms = Date.parse(row.timestamp);
    if (!Number.isFinite(ms)) continue;
    const when = new Date(ms);
    if (getETDateStr(when) !== today) continue;
    const minutes = getETTotalMinutes(when);
    if (minutes < MARKET_MINUTES.OPEN || minutes >= closeMinutes) continue;
    session.push({ ms, row });
  }
  session.sort((a, b) => a.ms - b.ms);

  // The latest row of each bucket. ET offsets are whole hours, so epoch-aligned
  // 5-minute windows are the ET-aligned ones.
  const lastOfBucket = new Map<number, { ms: number; row: Row }>();
  for (const entry of session) {
    lastOfBucket.set(Math.floor(entry.ms / BUCKET_MS) * BUCKET_MS, entry);
  }

  // No later run can fill a bucket from here on (see LAST_ATTEMPT_AFTER_CLOSE_MS).
  const pastLastAttempt =
    nowMs >=
    Date.parse(sessionWindowIso(today).closeIso) + LAST_ATTEMPT_AFTER_CLOSE_MS;

  const buckets: ClosedBucket[] = [];
  let pending = 0;
  let stuck = 0;
  let oldestStuck: string | null = null;
  // Map order is insertion order, and `session` is sorted: oldest bucket first.
  for (const [startMs, last] of lastOfBucket) {
    const endMs = startMs + BUCKET_MS;
    if (endMs + FINAL_LAG_MS > nowMs) continue; // R-closed: store it on a later run.

    // R-null: the bucket's value is its last minute's, so that minute's row
    // must be there (not an earlier one) and carry usable values.
    const hasLastMinute = last.ms >= endMs - MINUTE_MS;
    const values = hasLastMinute ? parseValues(last.row) : null;
    const label = new Date(labelMs(startMs)).toISOString();
    if (hasLastMinute && values !== null) {
      buckets.push({ timestamp: label, ...values });
    } else if (pastLastAttempt || nowMs - endMs >= STUCK_AFTER_MS) {
      stuck++;
      oldestStuck ??= label;
    } else {
      pending++;
    }
  }
  return {
    buckets,
    sessionRows: session.length,
    pending,
    stuck,
    oldestStuck,
  };
}

/**
 * True when the closed buckets are a degenerate snapshot: none has a usable
 * value although some are stuck, or every one has zero premium on both sides
 * (the QC "ALL values are zero/null" fingerprint — fired on zero_dte_index for
 * 2026-06-03). Storing it writes a flat series for the day, so the caller
 * drops the whole batch and raises an alert. Pending buckets alone never
 * count: UW being a few minutes late is not a degenerate feed.
 */
export function isDegenerate(
  result: Pick<ClosedBucketsResult, 'buckets' | 'stuck'>,
): boolean {
  if (result.buckets.length === 0) return result.stuck > 0;
  return result.buckets.every((b) => b.ncp === 0 && b.npp === 0);
}

/**
 * True when UW has sent no row for today's session although it is 09:40 ET or
 * later: UW rolls over between 09:28 and 09:32, so the feed has stalled.
 * Before 09:40 an empty answer is the normal pre-open state.
 */
export function isFeedStalled(sessionRows: number, now: Date): boolean {
  return sessionRows === 0 && getETTotalMinutes(now) >= STALL_FROM_ET_MINUTES;
}

/**
 * The UTC instants of 09:30 ET and the session close (16:00 ET, or 13:00 ET on
 * an early-close day) on ET day `day`, for the crons' data-quality queries
 * (R-quality): count only rows stamped on today's session, so the previous
 * session's rows cannot hide a dead day. The bounds are computed here, not in
 * SQL, to avoid the `date AT TIME ZONE` pitfall.
 */
export function sessionWindowIso(day: string): {
  openIso: string;
  closeIso: string;
} {
  const openIso = getETMarketOpenUtcIso(day);
  const closeIso = etWallClockToUtcIso(day, sessionCloseMinutes(day));
  if (openIso === null || closeIso === null) {
    throw new Error(`sessionWindowIso: malformed ET date "${day}"`);
  }
  return { openIso, closeIso };
}
