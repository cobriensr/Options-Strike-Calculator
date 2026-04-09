/**
 * Timezone-safe time extraction using Intl.DateTimeFormat.formatToParts().
 *
 * The common pattern `new Date(date.toLocaleString('en-US', { timeZone }))`
 * is fragile — some runtimes parse the locale-formatted string incorrectly.
 * formatToParts() returns structured data that doesn't require reparsing.
 */

const etFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: 'numeric',
  minute: 'numeric',
  weekday: 'short',
  hour12: false,
});

const ctFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  hour: 'numeric',
  minute: 'numeric',
  hour12: false,
});

const etDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function extractParts(
  formatter: Intl.DateTimeFormat,
  date: Date,
): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const { type, value } of formatter.formatToParts(date)) {
    parts[type] = value;
  }
  return parts;
}

/** Extract hour (0-23) and minute from a Date in Eastern Time. */
export function getETTime(date: Date): { hour: number; minute: number } {
  const parts = extractParts(etFormatter, date);
  return {
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/** Extract hour (0-23) and minute from a Date in Central Time. */
export function getCTTime(date: Date): { hour: number; minute: number } {
  const parts = extractParts(ctFormatter, date);
  return {
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/** Get the current ET date as YYYY-MM-DD. */
export function getETDateStr(date: Date): string {
  return etDateFormatter.format(date);
}

/** Get the day of week (0=Sun, 6=Sat) in Eastern Time. */
export function getETDayOfWeek(date: Date): number {
  const parts = extractParts(etFormatter, date);
  const dayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const weekday = parts.weekday;
  if (weekday && weekday in dayMap) return dayMap[weekday]!;
  return date.getDay();
}

/** Get total minutes since midnight in Eastern Time. */
export function getETTotalMinutes(date: Date): number {
  const { hour, minute } = getETTime(date);
  return hour * 60 + minute;
}

const DATE_STR_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Get the day of week (0=Sun, 6=Sat) for a YYYY-MM-DD date string.
 *
 * The date string represents a calendar date in Eastern Time (the
 * trading-day convention used throughout this codebase). Because the
 * weekday is a property of the calendar date itself — not of any
 * particular instant within it — we parse the components directly and
 * read the UTC weekday, side-stepping any host TZ or DST quirks.
 *
 * Returns null when the input is not a well-formed YYYY-MM-DD string
 * or denotes an invalid date (e.g. '2026-02-30').
 */
export function getETDayOfWeekFromDateStr(dateStr: string): number | null {
  const match = DATE_STR_RE.exec(dateStr);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Construct as UTC midnight so getUTCDay() reflects the calendar weekday
  // regardless of where the server is running.
  const d = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(d.getTime())) return null;
  // Reject roll-overs from invalid components (e.g. Feb 30 -> Mar 2).
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return d.getUTCDay();
}

/**
 * Computes the current CT→ET wall-clock offset in minutes by querying
 * Intl.DateTimeFormat.formatToParts() for both timezones at the same UTC
 * instant. Robust to DST mismatches and historical offset changes — does
 * NOT assume the +60-minute shorthand that's "correct by accident" because
 * ET and CT happen to share US DST rules today.
 *
 * Returns the number of minutes to ADD to a CT wall-clock time to get the
 * equivalent ET wall-clock time. (Currently always 60, but computed from
 * the actual zone data so it stays correct if zone rules ever diverge.)
 */
export function getCTToETOffsetMinutes(now: Date = new Date()): number {
  const etParts = extractParts(etFormatter, now);
  const ctParts = extractParts(ctFormatter, now);
  const etMinutes = Number(etParts.hour) * 60 + Number(etParts.minute);
  const ctMinutes = Number(ctParts.hour) * 60 + Number(ctParts.minute);
  // Account for day-boundary wraparound (e.g. CT is 11:30 PM on day N
  // while ET is 12:30 AM on day N+1). Wrap into [-12h, +12h] window.
  let diff = etMinutes - ctMinutes;
  if (diff > 12 * 60) diff -= 24 * 60;
  if (diff < -12 * 60) diff += 24 * 60;
  return diff;
}

/**
 * Converts a wall-clock time from Central Time to Eastern Time, returning
 * the result as 24-hour {hour, minute}. Uses the live IANA zone data via
 * Intl.DateTimeFormat — does NOT assume a fixed +1 hour offset.
 *
 * Both inputs are 0-23 (24h). Hours wrap into [0, 23] so a CT time near
 * midnight that crosses the day boundary in ET still returns a valid
 * normalized 24h hour. The market-hours validators that consume this
 * function operate well inside a single ET day, so day-rollover is the
 * safer behavior than returning > 23.
 */
export function convertCTToET(
  ctHour24: number,
  ctMinute: number,
  now: Date = new Date(),
): { hour: number; minute: number } {
  const offsetMin = getCTToETOffsetMinutes(now);
  const totalCtMinutes = ctHour24 * 60 + ctMinute;
  const totalEtMinutes = totalCtMinutes + offsetMin;
  const wrapped = ((totalEtMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  return {
    hour: Math.floor(wrapped / 60),
    minute: wrapped % 60,
  };
}
