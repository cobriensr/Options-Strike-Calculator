/**
 * CT-anchored trading-day generators shared across backfill scripts.
 *
 * Original bug (AUD-C4 — independently re-fixed three times yet copy-pasted
 * broken into ~20 scripts): `d.getDay()` reads the LOCAL-timezone weekday
 * while `d.toISOString().slice(0, 10)` reads the UTC date. Run from CT after
 * ~6 PM the UTC date is already tomorrow, so the weekday and the date string
 * disagreed — the loop pushed Saturday-labeled strings for Friday data and
 * silently dropped Mondays.
 *
 * These helpers anchor BOTH the date string and the weekday to
 * America/Chicago so they can never disagree. `spx-candles-1m` is
 * intentionally NOT a consumer: it is ET-anchored and excludes today by
 * design (completed-candle backfill) — a different contract.
 */

const CT_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** YYYY-MM-DD calendar date in CT for a given instant (default: now). */
export function ctDateStr(instant = new Date()) {
  return CT_FMT.format(instant);
}

/**
 * Weekday (0=Sun .. 6=Sat) of a YYYY-MM-DD date string. Anchored at 18:00 UTC
 * (midday CT regardless of DST) so the weekday never shifts across a day
 * boundary.
 */
function isWeekday(dateStr) {
  const dow = new Date(`${dateStr}T18:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6;
}

/**
 * The most recent `count` trading days (Mon–Fri) ending at today in CT,
 * ascending (YYYY-MM-DD). Includes today when today is a weekday — matches
 * the historical behavior of the per-script copies this replaces.
 */
export function getTradingDays(count) {
  const dates = new Set();
  let cursor = new Date();
  while (dates.size < count) {
    const d = CT_FMT.format(cursor);
    if (!dates.has(d) && isWeekday(d)) dates.add(d);
    cursor = new Date(cursor.getTime() - ONE_DAY_MS);
  }
  return Array.from(dates).sort((a, b) => a.localeCompare(b));
}

/**
 * Trading days (Mon–Fri) from `startDate` (YYYY-MM-DD) forward, up to `count`
 * days, never past today in CT, ascending. Replaces gex-0dte's forward walker.
 */
export function getTradingDaysForward(startDate, count) {
  const today = ctDateStr();
  const dates = [];
  // Step by CT calendar date from a midday-CT anchor so DST never drifts a
  // step across midnight.
  let cursor = new Date(`${startDate}T18:00:00Z`);
  while (dates.length < count) {
    const d = CT_FMT.format(cursor);
    if (d > today) break;
    if (isWeekday(d)) dates.push(d);
    cursor = new Date(cursor.getTime() + ONE_DAY_MS);
  }
  return dates;
}
