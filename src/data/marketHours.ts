/**
 * NYSE market hours: early close dates and full market closures.
 * Affects time-to-expiry (T) for 0DTE pricing.
 *
 * Update once per year from: https://www.nyse.com/markets/hours-calendars
 */

const EARLY_CLOSE_DATES: ReadonlyMap<string, number> = new Map([
  // 2025
  ['2025-07-03', 13], // Day before July 4th (Thursday)
  ['2025-11-28', 13], // Black Friday
  ['2025-12-24', 13], // Christmas Eve
  // 2026
  // NOTE: 2026-07-03 is NOT a half-day. July 4, 2026 falls on a Saturday,
  // so July 3 (Friday) is the observed Independence Day full closure — see
  // MARKET_CLOSED_DATES below.
  ['2026-11-27', 13], // Black Friday
  ['2026-12-24', 13], // Christmas Eve
]);

const MARKET_CLOSED_DATES: ReadonlySet<string> = new Set([
  // 2025
  '2025-04-18', // Good Friday
  '2025-05-26', // Memorial Day
  '2025-06-19', // Juneteenth
  '2025-07-04', // Independence Day
  '2025-09-01', // Labor Day
  '2025-11-27', // Thanksgiving
  '2025-12-25', // Christmas
  // 2026
  '2026-01-01', // New Year's Day
  '2026-01-19', // MLK Day
  '2026-02-16', // Presidents Day
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (observed)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas
]);

/**
 * Get the market close hour (ET, 24h) for a given date.
 * Returns 13 for early close days, 16 for normal days, null for closed days.
 */
export function getMarketCloseHourET(date: string): number | null {
  if (MARKET_CLOSED_DATES.has(date)) return null;
  return EARLY_CLOSE_DATES.get(date) ?? 16;
}

/**
 * Get the early close hour if applicable, or undefined for normal days.
 * Designed for passing to useCalculation's earlyCloseHourET parameter.
 */
export function getEarlyCloseHourET(date: string): number | undefined {
  return EARLY_CLOSE_DATES.get(date);
}

/**
 * Returns true if `date` is a NYSE-closed full holiday (e.g., Christmas,
 * Thanksgiving). Half-days return false because they are still trading days.
 *
 * Date format: 'YYYY-MM-DD' (calendar day, no timezone — half-days and
 * holidays are calendar-day-defined, not timestamp-defined).
 */
export function isHoliday(date: string): boolean {
  return MARKET_CLOSED_DATES.has(date);
}

/**
 * Returns true if `date` is a NYSE early-close day (1 PM ET close, e.g.,
 * Black Friday, Christmas Eve). These are still trading days but with
 * a 3.5h session instead of the usual 6.5h.
 *
 * Defensive: a date that appears in both sets (data-entry mistake) is
 * treated as a holiday, never a half-day. This guards against future
 * copy-paste errors in `EARLY_CLOSE_DATES` (see the 2026-07-03 incident).
 */
export function isHalfDay(date: string): boolean {
  if (MARKET_CLOSED_DATES.has(date)) return false;
  return EARLY_CLOSE_DATES.has(date);
}

/**
 * User's intraday trading schedule stage for the given moment.
 *
 * Reflects the five-phase workflow from `user_trading_schedule.md`:
 *   1. opening-range  8:30-9:00 CT   — establishing opening range, no trades
 *   2. credit-spreads 9:00-11:30 CT  — sell 0DTE credit spreads
 *   3. directional    11:30-1:00 CT  — buy 7DTE ~50Δ directional
 *   4. bwb            1:00-2:30 CT   — open 0DTE broken wing butterfly
 *   5. flat           2:55-3:00 CT   — close all non-0DTE positions
 *
 * Plus surrounding states:
 *   - pre-market   before 8:30 CT on a trading day
 *   - late-bwb     2:30-2:55 CT gap (managing BWB, no new positions)
 *   - post-close   after 3:00 CT on a trading day
 *   - half-day     NYSE early-close day — the five-phase schedule runs past
 *                  the noon CT close, so the helper returns this single
 *                  stage rather than guessing which phases to compress.
 *   - closed       Weekend or full-day NYSE holiday
 */
export type SessionStage =
  | 'pre-market'
  | 'opening-range'
  | 'credit-spreads'
  | 'directional'
  | 'bwb'
  | 'late-bwb'
  | 'flat'
  | 'post-close'
  | 'half-day'
  | 'closed';

/**
 * The five stages that correspond to active phases in the user's schedule.
 * A consumer can use this to ask "is this an actionable stage?" — the other
 * stage values (pre-market, late-bwb, post-close, half-day, closed) all
 * indicate "do not open new positions."
 */
export const ACTIVE_SESSION_STAGES: ReadonlySet<SessionStage> = new Set([
  'opening-range',
  'credit-spreads',
  'directional',
  'bwb',
  'flat',
]);

/**
 * Returns true if `date` is a US equity trading day — i.e., a weekday
 * (Mon-Fri) that is not a NYSE-closed holiday. Half-days ARE trading days
 * (just shorter), so this returns true for them.
 *
 * Date format: 'YYYY-MM-DD'. Parsed as UTC noon to avoid any timezone
 * ambiguity around the day-of-week computation — the calendar day is
 * what we care about, not the wall-clock instant.
 *
 * Returns false for malformed input rather than throwing.
 */
export function isTradingDay(date: string): boolean {
  // Holidays first — also catches the calendar-day-defined "weekend
  // observation" cases like 2026-07-03 (Independence Day observed).
  if (MARKET_CLOSED_DATES.has(date)) return false;

  const parts = date.split('-');
  if (parts.length !== 3) return false;
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return false;
  }

  // Use UTC noon so getUTCDay returns the calendar weekday regardless
  // of the runtime's local timezone. (See src/utils/time.ts:parseDow
  // and src/hooks/useHistoryData.ts:218 for the same pattern.)
  const d = new Date(Date.UTC(year, month - 1, day, 12));
  if (Number.isNaN(d.getTime())) return false;

  const dow = d.getUTCDay(); // 0 = Sun, 6 = Sat
  if (dow === 0 || dow === 6) return false;

  return true;
}

// ── Session-stage phase boundaries (Central Time minutes-of-day) ────

const STAGE_BOUNDS = {
  /** 8:30 CT — NYSE open (9:30 ET) */
  openingRangeStart: 8 * 60 + 30,
  /** 9:00 CT — end of opening-range observation */
  creditSpreadsStart: 9 * 60,
  /** 11:30 CT — end of credit-spread window */
  directionalStart: 11 * 60 + 30,
  /** 1:00 PM CT — end of directional window */
  bwbStart: 13 * 60,
  /** 2:30 PM CT — end of BWB-opening window */
  lateBwbStart: 14 * 60 + 30,
  /** 2:55 PM CT — beginning of the 5-minute flat window */
  flatStart: 14 * 60 + 55,
  /** 3:00 PM CT — NYSE close (4:00 PM ET), end of flat window */
  postCloseStart: 15 * 60,
} as const;

/**
 * Extract the CT calendar date (YYYY-MM-DD) and time-of-day minutes
 * from a Date using Intl.DateTimeFormat. Chosen over the
 * `new Date(toLocaleString(...))` shortcut because the latter parses
 * a timezone-naive string back through the system's local timezone,
 * which produces a Date object whose underlying UTC instant is wrong.
 *
 * Intl.DateTimeFormat.formatToParts is how timezone.ts does this.
 */
function getCTCalendarAndMinutes(instant: Date): {
  dateStr: string;
  minutes: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant);

  const pick = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? '';

  const year = pick('year');
  const month = pick('month');
  const day = pick('day');
  // hour12: false still returns '24' at midnight in some locales — normalize.
  const rawHour = pick('hour');
  const hour = rawHour === '24' ? 0 : Number(rawHour);
  const minute = Number(pick('minute'));

  return {
    dateStr: `${year}-${month}-${day}`,
    minutes: hour * 60 + minute,
  };
}

/**
 * Classify the current (or given) instant into one of the user's five
 * trading phases or a surrounding state. See `SessionStage` for the
 * full enum and `user_trading_schedule.md` for the workflow rationale.
 *
 * The returned stage is determined entirely by the CT wall-clock time
 * and the calendar-day type (trading day / half-day / holiday).
 *
 * Half-days return `'half-day'` as a conservative default: the
 * five-phase schedule runs past the noon CT close on half-days, and
 * the user hasn't defined which phases should compress. Consumers
 * that want to show a half-day-specific schedule should check
 * `isHalfDay(date)` and render a different flow.
 *
 * @param now  Instant to classify. Defaults to `new Date()`.
 */
export function currentSessionStage(now: Date = new Date()): SessionStage {
  const { dateStr, minutes } = getCTCalendarAndMinutes(now);

  if (!isTradingDay(dateStr)) return 'closed';
  if (isHalfDay(dateStr)) return 'half-day';

  if (minutes < STAGE_BOUNDS.openingRangeStart) return 'pre-market';
  if (minutes < STAGE_BOUNDS.creditSpreadsStart) return 'opening-range';
  if (minutes < STAGE_BOUNDS.directionalStart) return 'credit-spreads';
  if (minutes < STAGE_BOUNDS.bwbStart) return 'directional';
  if (minutes < STAGE_BOUNDS.lateBwbStart) return 'bwb';
  if (minutes < STAGE_BOUNDS.flatStart) return 'late-bwb';
  if (minutes < STAGE_BOUNDS.postCloseStart) return 'flat';
  return 'post-close';
}
