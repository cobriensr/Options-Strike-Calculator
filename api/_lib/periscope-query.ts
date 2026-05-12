/**
 * Shared query helpers + validation regexes for Periscope endpoints.
 *
 * Both `api/periscope-exposure.ts` (formatted Top-N view) and
 * `api/periscope-strikes.ts` (raw per-strike grid for the GEX Landscape)
 * need:
 *   - The same YYYY-MM-DD / HH:MM regex shapes for query-param validation
 *   - `endOfMinute()` ISO rounding so a slot captured at HH:MM:XX is
 *     included when the user picks HH:MM (the scrub round-trip depends
 *     on this; HH:MM truncates seconds otherwise)
 *   - `fetchSpxSpot()` — SPX close at-or-before asOf for ranking strikes
 *   - `fetchAvailableSlots()` — distinct captured_at list for the scrub
 *     stepper, anchored on panel='gamma' (per migration #141, gamma /
 *     charm / vanna land at the same captured_at)
 *
 * Kept here so the two endpoints can't drift on these primitives.
 */

import { getDb } from './db.js';

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Round an ISO timestamp UP to the end of its minute (XX:XX:59.999Z). */
export function endOfMinute(iso: string): string {
  const d = new Date(iso);
  d.setUTCSeconds(59, 999);
  return d.toISOString();
}

/**
 * Read the SPX close at-or-before `asOf` (ISO) for the given date, or
 * the latest close for that date when asOf is omitted. The authoritative
 * spot for ranking Periscope strikes (the periscope skill enforces:
 * never the chart's red dotted line).
 */
export async function fetchSpxSpot(
  date: string,
  asOf?: string,
): Promise<number | null> {
  const sql = getDb();
  const rows = asOf
    ? ((await sql`
        SELECT close
        FROM index_candles_1m
        WHERE symbol = 'SPX' AND date = ${date} AND timestamp <= ${asOf}
        ORDER BY timestamp DESC
        LIMIT 1
      `) as Array<{ close: string | number }>)
    : ((await sql`
        SELECT close
        FROM index_candles_1m
        WHERE symbol = 'SPX' AND date = ${date}
        ORDER BY timestamp DESC
        LIMIT 1
      `) as Array<{ close: string | number }>);
  if (rows.length === 0) return null;
  const v = Number(rows[0]!.close);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * List the distinct slot capture timestamps for the picked date, used
 * to back the prev/next stepper in the panel. Filters on panel='gamma'
 * — the per-row timeframe migration (#141) guarantees gamma / charm /
 * vanna land at the same captured_at, so gamma is a safe anchor.
 */
export async function fetchAvailableSlots(date: string): Promise<string[]> {
  const sql = getDb();
  const rows = (await sql`
    SELECT DISTINCT captured_at
    FROM periscope_snapshots
    WHERE expiry = ${date} AND panel = 'gamma'
    ORDER BY captured_at ASC
  `) as Array<{ captured_at: string | Date }>;
  return rows.map((r) =>
    r.captured_at instanceof Date ? r.captured_at.toISOString() : r.captured_at,
  );
}
