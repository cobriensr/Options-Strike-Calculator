/**
 * Parse a `market_snapshots.entry_time` label to a clock minute.
 *
 * The calculator writes `${hour}:${minute} ${AM|PM} ${CT|ET}` (src/App.tsx),
 * for example "9:30 AM CT" or "3:00 PM ET". Rows saved before the zone suffix
 * existed carry a bare "H:MM AM". One parser serves the API readers
 * (api/_lib/db-snapshots.ts) and the browser (VIX trajectory, analysis
 * history). Imported by api/, so relative imports here need `.js`.
 */

const ENTRY_TIME_PATTERN = /^(\d{1,2}):(\d{1,2})\s*(AM|PM)(?:\s+(CT|ET))?$/i;

/** ET's clock reads this many minutes ahead of CT's. */
const ET_AHEAD_OF_CT_MIN = 60;

/**
 * Minutes since midnight CT for an entry_time label, so labels in either zone
 * sort and subtract on one clock. "9:30 AM CT" is 570, and "10:30 AM ET" (the
 * same moment) is 570 too. A bare "H:MM AM" is read as CT. An ET label in the
 * hour after midnight ET comes out negative (the evening before in CT), which
 * still sorts first.
 *
 * NaN for anything else: "pre-market", an empty or free-form label, an hour
 * outside 1-12, a minute outside 0-59 or an unknown zone.
 */
export function parseEntryTimeMinutes(label: string): number {
  const match = ENTRY_TIME_PATTERN.exec(label.trim());
  if (!match) return Number.NaN;
  const [, hourText, minuteText, meridiem, zone] = match;
  const hour12 = Number.parseInt(hourText!, 10);
  const minute = Number.parseInt(minuteText!, 10);
  if (hour12 < 1 || hour12 > 12 || minute > 59) return Number.NaN;
  const isPm = meridiem!.toUpperCase() === 'PM';
  const hour24 = (hour12 % 12) + (isPm ? 12 : 0);
  const minutes = hour24 * 60 + minute;
  return zone?.toUpperCase() === 'ET' ? minutes - ET_AHEAD_OF_CT_MIN : minutes;
}
