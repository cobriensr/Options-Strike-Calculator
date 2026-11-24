/**
 * Which held opening range is the current one.
 *
 * `/api/intraday` dates the range it returns (`sessionDate`), and the page
 * holds that body across the day. A tab loaded before today's first bar, or
 * left open overnight or over a weekend, still holds a previous session's
 * range, and reading it as today's feeds the Opening Range card, the range
 * signal and the saved snapshot rows a stale value.
 *
 * The range is current when:
 * - its `sessionDate` is `etToday`; or
 * - `etToday` is not a trading day (a weekend or a holiday) and `sessionDate`
 *   is the last trading day before it. The server falls back to the last
 *   session on those days on purpose, and the page shows that range then.
 *
 * Otherwise it is null: on a trading day before today's first bar, a held
 * Friday range is null on Monday. A null or dateless body has no current
 * range, and neither does a session whose range is null.
 *
 * Pure, so a caller can read it against the app's shared ET clock
 * (`useETToday`, which changes at ET midnight) in render, with nothing held
 * between renders to go stale. It never throws: a malformed `etToday` has no
 * current range.
 *
 * @param etToday Today's ET date, YYYY-MM-DD.
 */

import { isTradingDay, priorTradingDay } from '../data/marketHours.js';
import type { IntradayResponse } from '../types/api';

export type OpeningRange = NonNullable<IntradayResponse['openingRange']>;

export function currentOpeningRange(
  intraday:
    | Pick<IntradayResponse, 'sessionDate' | 'openingRange'>
    | null
    | undefined,
  etToday: string,
): OpeningRange | null {
  if (intraday?.sessionDate == null) return null;
  const { sessionDate, openingRange } = intraday;

  if (sessionDate === etToday) return openingRange;
  if (isTradingDay(etToday)) return null;

  // priorTradingDay throws on a date it cannot read, and on a calendar with no
  // trading day within ten days of it. Neither has a current range.
  try {
    return sessionDate === priorTradingDay(etToday) ? openingRange : null;
  } catch {
    return null;
  }
}
