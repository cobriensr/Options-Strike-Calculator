/**
 * Client clock helpers for the GEXBot panels' after-close behavior: when the
 * session opens and closes, when the one final fetch of a session is due, and
 * how a carried-over capture is labelled.
 *
 * Imported by `api/` too (this folder is in `API_COMPILED_SRC`), so relative
 * imports carry explicit `.js` extensions.
 */

import {
  CASH_OPEN_MIN_ET,
  CLOSED_FINAL_FETCH_OFFSET_MIN,
  getMarketCloseHourET,
  isTradingDay,
} from '../data/marketHours.js';
import { formatSchwabExpiryCt } from './schwab-expiry.js';
import { etWallClockToUtcIso, getETDateStr } from './timezone.js';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * How many ET dates `nextFinalFetchMs` looks at. The longest closed run in the
 * calendar is a holiday beside a weekend, a few days; this is a generous bound
 * against a calendar that has run out. It also keeps the wait under
 * setTimeout's 24.8-day ceiling.
 */
const FINAL_FETCH_SEARCH_DAYS = 14;

/** A capture older than this is labelled with its date, not just its weekday. */
const DATED_LABEL_AFTER_MS = 6 * DAY_MS;

/** Epoch ms of the ET wall-clock minute on `etDate`, null off a trading day. */
function tradingDayInstantMs(
  etDate: string,
  etMinutesPastMidnight: number,
): number | null {
  if (!isTradingDay(etDate)) return null;
  const iso = etWallClockToUtcIso(etDate, etMinutesPastMidnight);
  return iso == null ? null : Date.parse(iso);
}

/** Epoch ms of 09:30 ET on etDate; null on a non-trading day. */
export function sessionOpenMs(etDate: string): number | null {
  return tradingDayInstantMs(etDate, CASH_OPEN_MIN_ET);
}

/** Epoch ms of the cash close on etDate (13:00 ET on a half day), null off a trading day. */
function sessionCloseMs(etDate: string): number | null {
  const closeHour = getMarketCloseHourET(etDate);
  return closeHour == null ? null : tradingDayInstantMs(etDate, closeHour * 60);
}

/**
 * True when the market is open and `newestCapture` (the newest capture a
 * live-route response carries: its asOf, else its last listed minute or slot)
 * is before today's (ET) session open. null → false.
 */
export function isCarriedOver(
  newestCapture: string | null,
  marketOpen: boolean,
  now: Date,
): boolean {
  if (newestCapture == null || !marketOpen) return false;
  const openMs = sessionOpenMs(getETDateStr(now));
  if (openMs == null) return false;
  // An unparseable capture is NaN, and NaN < anything is false.
  return Date.parse(newestCapture) < openMs;
}

/** An ISO 8601 date-time starts like this: a date, then `T`. */
const ISO_DATE_TIME_PREFIX = /^\d{4}-\d{2}-\d{2}T/;

/**
 * `raw` when it is an ISO 8601 date-time string that parses, else null. The
 * GEXBot hooks run an unchecked response body's `asOf` through it before the
 * closed label and `isCarriedOver` read it. A bare `Date.parse` is too loose
 * for that: it reads "2026" as a year and "5" as a month, so the string must
 * also have the shape of a date-time. Anything but a string (a number, an array
 * holding a timestamp) is rejected before it is parsed.
 */
export function asOfFrom(raw: unknown): string | null {
  return typeof raw === 'string' &&
    ISO_DATE_TIME_PREFIX.test(raw) &&
    Number.isFinite(Date.parse(raw))
    ? raw
    : null;
}

/** The ET calendar date after `etDate`. Steps from UTC noon, clear of DST. */
function nextEtDate(etDate: string): string {
  return new Date(Date.parse(`${etDate}T12:00:00Z`) + DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * Epoch ms of the first close + CLOSED_FINAL_FETCH_OFFSET_MIN strictly after
 * `after`, searching up to 14 days; null if none.
 *
 * The close is the day's own (13:00 ET on a half day), not a fixed 16:00.
 */
export function nextFinalFetchMs(after: Date): number | null {
  const afterMs = after.getTime();
  let etDate = getETDateStr(after);
  for (let day = 0; day < FINAL_FETCH_SEARCH_DAYS; day++) {
    const closeMs = sessionCloseMs(etDate);
    if (closeMs != null) {
      const fetchMs = closeMs + CLOSED_FINAL_FETCH_OFFSET_MIN * MINUTE_MS;
      if (fetchMs > afterMs) return fetchMs;
    }
    etDate = nextEtDate(etDate);
  }
  return null;
}

const CT_MONTH_DAY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  month: 'short',
  day: 'numeric',
});

/**
 * "Fri 3:00 PM CT", or "Fri Nov 20 3:00 PM CT" when now − asOf > 6 days.
 * America/Chicago always. Empty when `asOf` is not a timestamp.
 */
export function formatClosedLabel(asOf: string, now: Date): string {
  const asOfMs = Date.parse(asOf);
  if (Number.isNaN(asOfMs)) return '';
  const label = formatSchwabExpiryCt(asOfMs);
  if (now.getTime() - asOfMs <= DATED_LABEL_AFTER_MS) return label;
  const [weekday, ...rest] = label.split(' ');
  const monthDay = CT_MONTH_DAY.format(new Date(asOfMs));
  return [weekday, monthDay, ...rest].join(' ');
}

/**
 * A failure another try can clear: network, timeout or abort (status 0), 408,
 * 429 and 5xx. Any other 4xx is the request itself being refused.
 */
export function isTransientStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}
