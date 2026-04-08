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
