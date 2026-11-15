import type { getDb } from './db.js';

type Sql = ReturnType<typeof getDb>;

/**
 * Sargable bound of a TIMESTAMPTZ column to one CT calendar day:
 * `tsCol >= [00:00 CT of X]` AND `tsCol < [00:00 CT of X+1]`.
 *
 * `[X 00:00 CT, X+1 00:00 CT)` converted to instants is exactly the set of
 * instants whose CT calendar date is X, so this selects the same rows as
 * `date(tsCol AT TIME ZONE 'America/Chicago') = X`, but the column stays bare
 * and the bounds are query constants. A btree on the column can then
 * range-scan it; the `date(…)` form can't be served by any index and
 * seq-scans (strike_iv_snapshots, ~92M rows: 35.3 s vs 0.32 s).
 *
 * `::timestamp` before `AT TIME ZONE` matters: it makes the zone conversion
 * read the date as a CT wall-clock midnight instead of a UTC-session date.
 *
 * Tagged-template form for neon `sql\`…\`` callers; the result nests inside a
 * larger template. `tsCol` names the column (override when aliased).
 */
export function ctDayTsBounds(sql: Sql, dateIso: string, tsCol = 'timestamp') {
  const t = sql.unsafe(tsCol);
  return sql`${t} >= ((${dateIso}::date)::timestamp AT TIME ZONE 'America/Chicago')
    AND ${t} <  (((${dateIso}::date) + 1)::timestamp AT TIME ZONE 'America/Chicago')`;
}

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
 * calendar day `[00:00 CT, next 00:00 CT)` ({@link ctDayTsBounds}), which
 * excludes the stray. It is sargable: the timestamp bounds are query
 * constants, so the planner range-scans the index rather than evaluating
 * `date(timestamp AT TIME ZONE …)` row by row.
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
  return sql`${d} = ${dateIso}::date
    AND ${ctDayTsBounds(sql, dateIso, tsCol)}`;
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
