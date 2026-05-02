/**
 * Compute the `capturedAt` ISO instant for a TRACE Live capture.
 *
 * Shared between:
 *   - `scripts/capture-trace-live.ts` (the Playwright capture script that
 *     emits the value over stdout to the daemon),
 *   - `daemon/src/backfill.ts` (which pre-computes the same value to
 *     idempotently skip slots already written).
 *
 * The two consumers MUST produce byte-identical ISO strings — the
 * backfill idempotency check uses a +/-60s window for safety, but any
 * drift here would make the existence-check window-relative instead of
 * timestamp-equal, masking real bugs.
 *
 * Method: take the user's CT trading time, convert to ET (CT + 60min),
 * probe America/New_York's UTC offset for the calendar day via
 * Intl.DateTimeFormat.shortOffset, and append it to the ET wall-clock
 * string before passing to the Date constructor. This is correct across
 * DST transitions because the offset is recomputed per-date.
 *
 * Pure function. No DOM, no Node-specific APIs (Intl is universal).
 * Safe to import from `daemon/src/`, `scripts/`, and `src/components/`.
 */

const OFFSET_PATTERN = /GMT([+-]\d+)/;

/**
 * @param date     Calendar date (ET trading day) in YYYY-MM-DD format.
 *                 Must be a valid Gregorian date string; malformed input
 *                 falls through to NaN and produces 'Invalid Date' on
 *                 toISOString -- caller should validate first.
 * @param hourCt   Hour-of-day in Central Time (0-23). 8 = 8 AM CT.
 * @param minuteCt Minute-of-hour in Central Time (0-59).
 * @returns        ISO 8601 UTC string (with millisecond precision).
 */
export function computeCapturedAtIso(
  date: string,
  hourCt: number,
  minuteCt: number,
): string {
  // CT -> ET wall-clock. The slider, the GEX cron rows, and the dashboard
  // all key off ET, so we add 1h to the user's CT input before probing
  // the TZ offset. This is correct year-round because CT and ET share
  // the same DST transitions -- they're always offset by exactly 1h.
  const isoLocal = `${date}T${String(hourCt + 1).padStart(2, '0')}:${String(minuteCt).padStart(2, '0')}:00`;

  // Probe ET's UTC offset for the calendar day. We use noon UTC because
  // it lies inside the ET calendar day regardless of which side of DST
  // the date falls on -- avoids the 1am-2am ambiguity at fall-back.
  const probe = new Date(`${date}T12:00:00Z`);
  const etDateFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  });
  const offsetParts = etDateFmt.formatToParts(probe);
  const tz = offsetParts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  const offsetMatch = OFFSET_PATTERN.exec(tz);
  // Default -5 (EST) if Intl returned an unexpected shape -- safer than
  // throwing in a pure helper. Modern Node/V8 always returns 'GMT-4' or
  // 'GMT-5' for America/New_York.
  const offsetHours = offsetMatch
    ? Number.parseInt(offsetMatch[1]!, 10)
    : -5;
  const sign = offsetHours < 0 ? '-' : '+';
  const offsetStr = `${sign}${String(Math.abs(offsetHours)).padStart(2, '0')}:00`;
  return new Date(`${isoLocal}${offsetStr}`).toISOString();
}
