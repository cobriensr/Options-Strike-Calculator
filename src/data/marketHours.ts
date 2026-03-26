/**
 * NYSE market hours: early close dates and full market closures.
 * Affects time-to-expiry (T) for 0DTE pricing.
 *
 * Update once per year from: https://www.nyse.com/markets/hours-calendars
 */

const EARLY_CLOSE_DATES: ReadonlyMap<string, number> = new Map([
  // 2025
  ['2025-07-03', 13], // Day before July 4th
  ['2025-11-28', 13], // Black Friday
  ['2025-12-24', 13], // Christmas Eve
  // 2026
  ['2026-07-03', 13], // Day before July 4th
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
