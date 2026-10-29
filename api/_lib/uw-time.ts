/**
 * Unusual Whales futures time stamps at microsecond precision.
 *
 * UW's REST futures endpoints page newest-first with an `older_than`
 * cursor that is STRICT (rows executed before it). Prints share
 * timestamps, so the next cursor is the page's oldest `executed_at` plus
 * one microsecond, with `trade_id` dedup for the re-returned boundary
 * rows (probe 0a: 0 of 27,674 prints lost). A JS `Date` holds only
 * milliseconds, which would round that cursor, so times are carried as
 * bigint epoch microseconds here.
 *
 * Accepted forms, mirroring uw-stream's `utils/timestamps.py`:
 *   - an ISO-8601 string WITH an offset (REST: `2026-10-28T14:00:00.015573Z`,
 *     blocks at second precision). Fractions past 6 digits are truncated.
 *   - epoch MILLISECONDS as a number or a digit string (websocket frames).
 * A naive ISO time is rejected: guessing its zone would shift it by hours.
 * Every form must land inside [2000-01-01, now + 5 min], which also
 * catches epoch seconds read as milliseconds (1970).
 */

/** 2000-01-01 in epoch ms. */
const MIN_PLAUSIBLE_MS = 946_684_800_000;
/** Allowed lead over the wall clock: clock skew, nothing more. */
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

const EPOCH_MS_RE = /^\d+$/;
const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})$/;

function plausible(ms: number): boolean {
  return ms >= MIN_PLAUSIBLE_MS && ms <= Date.now() + MAX_FUTURE_SKEW_MS;
}

function parseIso(s: string): bigint | null {
  const m = ISO_RE.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec, frac = '', zone] = m;
  // Date.parse rolls an impossible date (02-30) into the next month.
  const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (
    day.getUTCFullYear() !== Number(y) ||
    day.getUTCMonth() !== Number(mo) - 1 ||
    day.getUTCDate() !== Number(d)
  ) {
    return null;
  }
  const secondsMs = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${sec}${zone}`);
  if (!Number.isFinite(secondsMs)) return null;
  const micros = BigInt(frac.padEnd(6, '0').slice(0, 6));
  return BigInt(secondsMs) * 1000n + micros;
}

/**
 * Epoch microseconds for a UW time, or null when `v` is absent,
 * unparseable, naive, or outside the plausibility window.
 */
export function parseUwTimeMicros(v: unknown): bigint | null {
  let us: bigint | null = null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    us = BigInt(Math.trunc(v)) * 1000n;
  } else if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return null;
    us = EPOCH_MS_RE.test(s) ? BigInt(s) * 1000n : parseIso(s);
  }
  if (us === null) return null;
  return plausible(Number(us / 1000n)) ? us : null;
}

/** ISO-8601 UTC with six fractional digits: `2026-10-28T14:00:00.015573Z`. */
export function formatMicrosIso(us: bigint): string {
  const seconds = new Date(Number(us / 1000n)).toISOString().slice(0, 19);
  const frac = (us % 1_000_000n).toString().padStart(6, '0');
  return `${seconds}.${frac}Z`;
}
