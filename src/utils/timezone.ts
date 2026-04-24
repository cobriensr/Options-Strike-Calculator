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
 * Convert a YYYY-MM-DD ET calendar date into the UTC ISO timestamp for
 * 9:30 AM ET (cash-session open) on that date. Handles both EDT and EST
 * by probing the zone's offset at noon ET on the given date via
 * Intl.DateTimeFormat — no hardcoded offset, so the result stays correct
 * across DST boundaries and future TZ rule changes.
 *
 * Example: '2026-04-17' (EDT) → '2026-04-17T13:30:00.000Z'
 *          '2026-01-15' (EST) → '2026-01-15T14:30:00.000Z'
 *
 * Returns `null` when the input is malformed.
 */
const ET_OFFSET_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  timeZoneName: 'shortOffset',
  year: 'numeric',
});

export function getETMarketOpenUtcIso(dateStr: string): string | null {
  return etWallClockToUtcIso(dateStr, 9 * 60 + 30);
}

/**
 * Convert a YYYY-MM-DD ET calendar date into the UTC ISO timestamp for
 * 4:00 PM ET (cash-session close) on that date. Handles both EDT and EST
 * so callers don't have to hardcode "T21:00:00Z" (EST-only) — during EDT
 * the actual close is 20:00 UTC.
 *
 * Example: '2026-04-23' (EDT) -> '2026-04-23T20:00:00.000Z'
 *          '2026-01-15' (EST) -> '2026-01-15T21:00:00.000Z'
 *
 * Returns `null` when the input is malformed.
 */
export function getETCloseUtcIso(dateStr: string): string | null {
  return etWallClockToUtcIso(dateStr, 16 * 60);
}

/**
 * Shared helper: convert an ET wall-clock minute-of-day on a given ET
 * calendar date into the corresponding UTC ISO string. Probes ET's UTC
 * offset at noon via Intl.DateTimeFormat, so the result is correct across
 * both DST phases and any future TZ rule changes.
 */
function etWallClockToUtcIso(
  dateStr: string,
  etMinutesPastMidnight: number,
): string | null {
  const dateMatch = DATE_STR_RE.exec(dateStr);
  if (!dateMatch) return null;
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);

  // Probe ET's UTC offset at noon on the given date. Noon is safely
  // inside the day even when DST transitions at 2 AM.
  const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (Number.isNaN(probe.getTime())) return null;
  // Reject roll-overs from invalid components (e.g. '2026-13-01' ->
  // Date.UTC wraps it to Jan 2027). The probe Date would still be valid,
  // so we validate each component against the reconstructed date.
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }

  const parts = extractParts(ET_OFFSET_FORMATTER, probe);
  const tzName = parts.timeZoneName ?? '';
  // tzName is like "GMT-4" (EDT) or "GMT-5" (EST); parse the signed hour.
  const offsetParsed = /GMT([+-]\d+)(?::(\d+))?/.exec(tzName);
  if (!offsetParsed) return null;
  const offsetHours = Number.parseInt(offsetParsed[1]!, 10);
  const offsetMinutes = offsetParsed[2]
    ? Number.parseInt(offsetParsed[2], 10)
    : 0;
  // Offset direction: "GMT-4" means ET is 4 hours *behind* UTC, so UTC =
  // ET + 4 hours. 9:30 AM ET + 4h = 13:30 UTC.
  const signedOffsetMin =
    (offsetHours < 0 ? -1 : 1) * (Math.abs(offsetHours) * 60 + offsetMinutes);
  // UTC minutes past UTC-midnight = ET minutes - signedOffsetMin.
  // (When offset is -4h = -240, 570 ET-min -> 570 - (-240) = 810 = 13:30 UTC.)
  const utcTotalMin = etMinutesPastMidnight - signedOffsetMin;
  const utcHour = Math.floor(utcTotalMin / 60);
  const utcMinute = utcTotalMin % 60;
  // Construct the UTC ISO string directly (avoids Date's local-TZ trap).
  return new Date(
    Date.UTC(year, month - 1, day, utcHour, utcMinute, 0, 0),
  ).toISOString();
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
