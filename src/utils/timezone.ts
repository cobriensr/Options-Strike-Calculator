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
