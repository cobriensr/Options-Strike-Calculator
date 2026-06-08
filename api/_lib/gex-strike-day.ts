import type { getDb } from './db.js';

type Sql = ReturnType<typeof getDb>;

/**
 * Sargable CT-trading-day filter for `gex_strike_0dte`.
 *
 * The fetch cron mis-stamps a stray prior-evening snapshot under the NEXT
 * trading day's `date` column (UW serves a frozen pre-market cache that the
 * writer stored with the wrong wall-clock date). A bare `date = X` — or worse,
 * `min/max(timestamp) WHERE date = X` — then picks that stray instead of the
 * day's real open/midday/close profile.
 *
 * This predicate keeps `date = X` (so the composite (date,timestamp,strike)
 * index still drives the scan) AND restricts `timestamp` to X's actual CT
 * calendar day `[00:00 CT, next 00:00 CT)`, which excludes the stray. It is
 * sargable: the timestamp bounds are query constants, so the planner
 * range-scans the index rather than evaluating `date(timestamp AT TIME ZONE …)`
 * row by row.
 *
 * Tagged-template form for neon `sql\`…\`` callers. `dateCol`/`tsCol` override
 * the column names when the table is aliased (e.g. `g.date` / `g.timestamp`).
 */
export function gexCtDayFilter(
  sql: Sql,
  dateIso: string,
  dateCol = 'date',
  tsCol = 'timestamp',
) {
  const d = sql.unsafe(dateCol);
  const t = sql.unsafe(tsCol);
  return sql`${d} = ${dateIso}::date
    AND ${t} >= ((${dateIso}::date)::timestamp AT TIME ZONE 'America/Chicago')
    AND ${t} <  (((${dateIso}::date) + 1)::timestamp AT TIME ZONE 'America/Chicago')`;
}

/**
 * Raw-SQL ($N-parameter) variant of {@link gexCtDayFilter} for callers that
 * build a string passed to `sql.query(text, params)`. `dateParam` is the
 * placeholder holding the ISO date (e.g. `'$1'`).
 */
export function gexCtDayFilterSql(
  dateParam: string,
  dateCol = 'date',
  tsCol = 'timestamp',
): string {
  return `${dateCol} = ${dateParam}::date
    AND ${tsCol} >= ((${dateParam}::date)::timestamp AT TIME ZONE 'America/Chicago')
    AND ${tsCol} <  (((${dateParam}::date) + 1)::timestamp AT TIME ZONE 'America/Chicago')`;
}
