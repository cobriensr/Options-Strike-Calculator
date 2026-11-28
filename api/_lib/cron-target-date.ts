/**
 * The ET date a day-keyed cron works on: a manual `?date=` when one is
 * given, else the cron's own default.
 *
 * A nightly cron targets "the day that just ended", so nothing ever
 * revisits a day whose source bars were repaired afterwards. `?date=`
 * lets an authorized call (the CRON_SECRET bearer) redo that one day.
 * Vercel's scheduler sends no query, so the schedule is unaffected.
 *
 * One rule for every cron that takes it (`embed-yesterday`,
 * `fetch-day-ohlc`), so a rebuild that calls them one after another passes
 * the same date to both and gets the same verdict from each.
 */

import { parseIsoDate } from '../../src/data/marketHours.js';

/**
 * A rejected `?date=`: no day was targeted, so a wrapper's error payload
 * carries no date. Name-checked by `instanceof`, so a cron's own failure
 * after it chose a target is never taken for a bad parameter.
 */
export class InvalidDateParamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDateParamError';
  }
}

/**
 * The ET date to work on: `dateParam` when given and valid, else
 * `fallback(today)`.
 *
 * `dateParam` is `req.query.date`, so it is `unknown`: a repeated param
 * arrives as an array, and an array holding one date is still not a
 * string. It must be a real YYYY-MM-DD calendar date strictly BEFORE
 * `today` (ET), since a day is processed once it is over; a bad format,
 * today, a later day or a repeated param throws `InvalidDateParamError`.
 *
 * Only the calendar is checked. Whether the date was a trading day, and
 * whether its bars are complete, stay the cron's own call.
 *
 * `job` prefixes the error message, so a response says which cron refused.
 */
export function resolveTargetDate(
  dateParam: unknown,
  today: string,
  fallback: (today: string) => string,
  job: string,
): string {
  if (dateParam === undefined) return fallback(today);
  if (typeof dateParam !== 'string' || parseIsoDate(dateParam) == null) {
    throw new InvalidDateParamError(
      `${job}: invalid date param (expected YYYY-MM-DD)`,
    );
  }
  if (dateParam >= today) {
    throw new InvalidDateParamError(
      `${job}: date ${dateParam} is not before today (${today})`,
    );
  }
  return dateParam;
}
