/**
 * The 0DTE regime session on the CT clock: where `now` sits against 08:30 CT
 * and the day's close. `useRegime0dte` polls only in `'open'`; the panel reads
 * the other three to say why it is not drawing (the day is over, the open is
 * still ahead, or there is no session today).
 *
 * The session runs on trading days only (no weekend, no NYSE holiday), from
 * 08:30 CT up to the day's close: 15:00 CT normally, 12:00 CT on a half-day.
 * `getMarketCloseHourET` is an ET hour; ET is always one hour ahead of CT, so
 * the close in CT minutes is `(closeHourET - 1) * 60`. A null close (a listed
 * holiday) is no session; a weekend has a normal close hour, so `isTradingDay`
 * is what rules it out.
 */

import { isTradingDay, getMarketCloseHourET } from '../data/marketHours.js';
import { getCTDateStr, getCTTime } from './timezone.js';

export type Regime0dteSessionPhase =
  | 'no-session'
  | 'before-open'
  | 'open'
  | 'after-close';

/** 08:30 CT, in CT minutes after midnight. */
const SESSION_OPEN_MIN_CT = 8 * 60 + 30;

export function regime0dteSessionPhase(now: Date): Regime0dteSessionPhase {
  const ctDate = getCTDateStr(now);
  const closeHourET = getMarketCloseHourET(ctDate);
  if (closeHourET === null || !isTradingDay(ctDate)) return 'no-session';
  const { hour, minute } = getCTTime(now);
  const totalMinutes = hour * 60 + minute;
  if (totalMinutes < SESSION_OPEN_MIN_CT) return 'before-open';
  return totalMinutes < (closeHourET - 1) * 60 ? 'open' : 'after-close';
}
