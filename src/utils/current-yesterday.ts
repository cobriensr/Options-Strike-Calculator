/**
 * Which held "yesterday" is the right session.
 *
 * `/api/yesterday` answers with the last completed session before today, and
 * the page holds that body across the day. A body fetched yesterday morning,
 * or served from an edge cache a day old, names a day that is no longer
 * yesterday: the cluster multiplier, the realized-vs-implied card and the
 * median ranges all read it, and all were a session off.
 *
 * The held value is current when its date is the last trading day before
 * `etToday`. That holds on a trading day, a weekend and a holiday alike,
 * because the endpoint drops today's candle: Monday's yesterday is Friday,
 * and so is Saturday's. Anything else is null, so a stale day shows nothing
 * rather than a wrong day.
 *
 * Generic over the value's shape: it only reads `date`, and hands back the
 * object it was given.
 *
 * Pure, and it never throws: a malformed `etToday` has no current yesterday.
 *
 * @param etToday Today's ET date, YYYY-MM-DD, from the app's date clock.
 */

import { priorTradingDay } from '../data/marketHours.js';

export function currentYesterday<T extends { readonly date: string }>(
  yesterday: T | null | undefined,
  etToday: string,
): T | null {
  if (yesterday == null) return null;

  // priorTradingDay throws on a date it cannot read, and on a calendar with no
  // trading day within ten days of it. Neither has a current yesterday.
  try {
    return yesterday.date === priorTradingDay(etToday) ? yesterday : null;
  } catch {
    return null;
  }
}
