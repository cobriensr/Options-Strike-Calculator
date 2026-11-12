/**
 * The Fed's FOMC decision-day calendar: the one TypeScript home of it.
 *
 * `api/_lib/market-events.ts` lists the days, and the feature builder
 * (`build-features-phase2.ts`) and the gamma detector (`gamma-detector.ts`)
 * ask `isFomcDecisionDay`. The ML code keeps two copies
 * (`ml/src/options_features/calendar.py` and
 * `ml/src/setups_backtest/econ_calendar.csv`).
 * `api/__tests__/fomc-schedule.test.ts` fails when either disagrees with this
 * file, so change them together.
 */

// Each list holds the decision day (second day) of every scheduled meeting.
// Source: https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm.
// Add next year's list when the Fed publishes it.
const FOMC_DATES_2025 = [
  '2025-01-29',
  '2025-03-19',
  '2025-05-07',
  '2025-06-18',
  '2025-07-30',
  '2025-09-17',
  '2025-10-29',
  '2025-12-10',
] as const;

const FOMC_DATES_2026 = [
  '2026-01-28',
  '2026-03-18',
  '2026-04-29',
  '2026-06-17',
  '2026-07-29',
  '2026-09-16',
  '2026-10-28',
  '2026-12-09',
] as const;

const FOMC_DATES_2027 = [
  '2027-01-27',
  '2027-03-17',
  '2027-04-28',
  '2027-06-09',
  '2027-07-28',
  '2027-09-15',
  '2027-10-27',
  '2027-12-08',
] as const;

// Decision days whose meeting also publishes the Summary of Economic
// Projections (the dot plot).
const SEP_DATES: ReadonlySet<string> = new Set([
  '2025-03-19',
  '2025-06-18',
  '2025-09-17',
  '2025-12-10',
  '2026-03-18',
  '2026-06-17',
  '2026-09-16',
  '2026-12-09',
  '2027-03-17',
  '2027-06-09',
  '2027-09-15',
  '2027-12-08',
]);

/** Every scheduled decision day, all years, ascending, as `YYYY-MM-DD`. */
export const FOMC_DECISION_DATES: readonly string[] = [
  ...FOMC_DATES_2025,
  ...FOMC_DATES_2026,
  ...FOMC_DATES_2027,
].sort();

const FOMC_DECISION_SET: ReadonlySet<string> = new Set(FOMC_DECISION_DATES);

/** True when `date` (`YYYY-MM-DD`) is a scheduled Fed rate-decision day. */
export function isFomcDecisionDay(date: string): boolean {
  return FOMC_DECISION_SET.has(date);
}

/** True when `date` (`YYYY-MM-DD`) is a decision day that carries the SEP. */
export function isSepMeeting(date: string): boolean {
  return SEP_DATES.has(date);
}
