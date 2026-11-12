/**
 * When a waiting service worker may be applied without asking. Applying it
 * reloads the page, which drops every typed input (none of the input hooks
 * persist) and any in-flight `/api/analyze` request, so the rule picks moments
 * when nobody is trading in this window.
 */

import { getMarketCloseHourET } from '../data/marketHours';
import {
  getETDateStr,
  getETDayOfWeek,
  getETTotalMinutes,
} from '../utils/timezone';

/** 09:30 ET (08:30 CT), the cash open, in ET minutes after midnight. */
const CASH_OPEN_MIN_ET = 9 * 60 + 30;

export interface SafeMomentContext {
  /** `document.visibilityState === 'hidden'`. */
  hidden: boolean;
  now: Date;
  /** Something holds the update: a chart analysis is in flight. */
  busy: boolean;
}

/**
 * True from the open until the day's close in ET, on a trading day. Works in
 * ET so a DST change can't move the window: 08:30 CT is always 09:30 ET.
 * `getMarketCloseHourET` knows holidays (null) and half-days (13), but not
 * weekends, so the weekday is checked here. Holidays outside the years listed
 * in marketHours.ts read as trading days, which errs toward not reloading.
 */
function isCashSessionOpen(now: Date): boolean {
  const weekday = getETDayOfWeek(now);
  if (weekday === 0 || weekday === 6) return false;
  const closeHour = getMarketCloseHourET(getETDateStr(now));
  if (closeHour === null) return false;
  const minutes = getETTotalMinutes(now);
  return minutes >= CASH_OPEN_MIN_ET && minutes < closeHour * 60;
}

/**
 * Owner's rule (2026-11-11): never while something holds the update; yes when
 * the tab is hidden; yes outside the cash session (before 08:30 CT, after the
 * day's close, weekends, holidays); otherwise no, and the banner stays until
 * the next safe moment.
 */
export function isSafeToApplyUpdate({
  hidden,
  now,
  busy,
}: SafeMomentContext): boolean {
  if (busy) return false;
  if (hidden) return true;
  return !isCashSessionOpen(now);
}
