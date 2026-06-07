/**
 * Shared coercion for Neon HTTP-driver date/timestamp columns.
 *
 * The Neon serverless driver returns:
 *   - Postgres DATE        → a JS `Date` at UTC midnight (e.g. the stored
 *     calendar date '2026-06-04' arrives as 2026-06-04T00:00:00.000Z), OR a
 *     plain 'YYYY-MM-DD' string depending on the column/driver path.
 *   - Postgres TIMESTAMPTZ → an ISO 8601 string (or occasionally a Date).
 *
 * A Postgres DATE has NO timezone — it is a bare calendar date. So we read the
 * day from its UTC components, NOT via an ET/CT conversion: converting a
 * UTC-midnight Date through `America/New_York` would shift it back a day. The
 * literal date stored (which IS the ET trading-day convention used everywhere
 * else) is exactly `toISOString().slice(0, 10)`.
 *
 * Centralised here so the capture cron (which compares an `expiry` DATE to the
 * ET trade-date for the 0DTE test) and the read store coerce identically.
 */

/** Coerce a Neon DATE column (string | Date) to a 'YYYY-MM-DD' calendar date. */
export function neonDateStr(v: string | Date): string {
  if (typeof v === 'string') return v.slice(0, 10);
  return v.toISOString().slice(0, 10);
}

/** Coerce a Neon TIMESTAMPTZ column (string | Date) to a full ISO string. */
export function neonIso(v: string | Date): string {
  return typeof v === 'string' ? v : v.toISOString();
}
