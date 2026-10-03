/**
 * Shared "un-archived session dates" predicate for the GEXBot archive and
 * cleanup crons.
 *
 * A date `d` is un-archived when `d < beforeDate`, the table has at least
 * one row captured on `d`, and `gexbot_archive_audit` has no row for
 * `(table_name, d)`.
 *
 * Day boundaries are UTC calendar days: `d::timestamptz` is midnight in the
 * session time zone (UTC on Neon), the same predicate `archive-gexbot.ts`
 * uses to select a day's rows. Mirroring it exactly means a row is counted
 * for the same day the archive would export it.
 * GexBot sessions run 13:30-21:01 UTC across DST and never straddle UTC
 * midnight, so a UTC calendar day is exactly one ET session date. Do not
 * "fix" these boundaries to ET: that would break parity with streamRows.
 *
 * Archive and cleanup both depend on this one predicate so they can never
 * disagree about what is "archived": cleanup deletes only days before
 * `beforeDate` that this helper does not return, and archive repairs the
 * days it does return.
 *
 * `generate_series` from `MIN(captured_at)::date` lets the query probe the
 * `captured_at` index once per day instead of scanning every row for a
 * DISTINCT.
 */

import type { NeonQueryFunction } from '@neondatabase/serverless';

import { withDbRetry } from './db.js';

type Sql = NeonQueryFunction<false, false>;

export const GEXBOT_ARCHIVE_TABLES = [
  'gexbot_snapshots',
  'gexbot_api_capture',
] as const;

export type GexbotArchiveTable = (typeof GEXBOT_ARCHIVE_TABLES)[number];

/**
 * Session dates (ascending 'YYYY-MM-DD') strictly before `beforeDate` that
 * hold rows in `table` but have no `gexbot_archive_audit` row.
 */
export async function listUnarchivedDates(
  sql: Sql,
  table: GexbotArchiveTable,
  beforeDate: string,
): Promise<string[]> {
  // The tagged template parameterizes values, not identifiers, so each
  // table gets its own branch (same pattern as archive-gexbot streamRows).
  const rows = (
    table === 'gexbot_snapshots'
      ? await withDbRetry(
          () => sql`
            WITH bounds AS (
              SELECT MIN(captured_at)::date AS lo FROM gexbot_snapshots
            ),
            days AS (
              SELECT generate_series(
                lo, ${beforeDate}::date - 1, INTERVAL '1 day'
              )::date AS d
              FROM bounds WHERE lo IS NOT NULL
            )
            SELECT to_char(d, 'YYYY-MM-DD') AS d
            FROM days
            WHERE EXISTS (
              SELECT 1 FROM gexbot_snapshots t
              WHERE t.captured_at >= days.d::timestamptz
                AND t.captured_at < (days.d + 1)::timestamptz
            )
            AND NOT EXISTS (
              SELECT 1 FROM gexbot_archive_audit a
              WHERE a.table_name = 'gexbot_snapshots' AND a.archive_date = days.d
            )
            ORDER BY d
          `,
          2,
          10_000,
        )
      : await withDbRetry(
          () => sql`
            WITH bounds AS (
              SELECT MIN(captured_at)::date AS lo FROM gexbot_api_capture
            ),
            days AS (
              SELECT generate_series(
                lo, ${beforeDate}::date - 1, INTERVAL '1 day'
              )::date AS d
              FROM bounds WHERE lo IS NOT NULL
            )
            SELECT to_char(d, 'YYYY-MM-DD') AS d
            FROM days
            WHERE EXISTS (
              SELECT 1 FROM gexbot_api_capture t
              WHERE t.captured_at >= days.d::timestamptz
                AND t.captured_at < (days.d + 1)::timestamptz
            )
            AND NOT EXISTS (
              SELECT 1 FROM gexbot_archive_audit a
              WHERE a.table_name = 'gexbot_api_capture' AND a.archive_date = days.d
            )
            ORDER BY d
          `,
          2,
          10_000,
        )
  ) as Array<Record<string, unknown>>;
  return rows.map((r) => String(r.d));
}
