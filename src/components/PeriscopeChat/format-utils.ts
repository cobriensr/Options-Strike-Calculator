/**
 * Date / number formatters shared across the Periscope chat panels.
 * Kept separate from PeriscopeProse.tsx so that file can stay
 * component-only (Vite's fast-refresh requires that).
 */

/**
 * Format a date-ish input ("YYYY-MM-DD" or full ISO timestamp) as a
 * terse "Mon DD" label. Postgres DATE columns come back as full ISO
 * timestamps via the Neon serverless driver's JSON serialization, but
 * test fixtures and some other code paths pass plain YYYY-MM-DD —
 * normalize both shapes here so callers don't have to.
 *
 * Falls back to the raw input if parsing fails (rather than rendering
 * "Invalid Date" to the user).
 */
export function fmtTradingDate(input: string | null | undefined): string {
  if (!input) return '—';
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return input;
  // Force UTC to avoid the YYYY-MM-DD-as-UTC-midnight rollback in
  // negative-offset timezones rendering as the previous day.
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
