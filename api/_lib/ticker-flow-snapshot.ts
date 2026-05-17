/**
 * Ticker cumulative net-flow snapshot at a given fire time.
 *
 * Replaces the per-row LEFT JOIN LATERAL that commits 26b13630 + 426c1e91
 * added to all 7 lottery + silent-boom feed sort branches (caused ~30s
 * page loads). The snapshot is now computed once at detect time and
 * persisted to lottery_finder_fires.cum_ncp_at_fire / cum_npp_at_fire
 * (migration #158) so the feed query becomes a single column read.
 *
 * SQL is the same UNION/DISTINCT ON pattern as the original LATERAL,
 * but bounded by `ctSessionBounds(date).min` (the 08:30 CT session open)
 * instead of `date::timestamptz` (UTC midnight, 4-6h too wide).
 *
 * Spec: docs/superpowers/specs/lottery-silentboom-feed-perf-2026-05-17.md
 */

import type { getDb } from './db.js';
import { ctSessionBounds } from '../../src/components/LotteryFinder/ct-window.js';

export interface TickerFlowSnapshot {
  cumNcp: number | null;
  cumNpp: number | null;
}

/**
 * A pre-fetched ticker-day cumulative series suitable for binary-search
 * lookups when many fires share the same (ticker, date) within a single
 * cron tick. Use `fetchTickerFlowSeries()` to build, `flowAtFireTime()`
 * to read.
 */
export interface TickerFlowSeries {
  /** Sorted ascending. Epoch milliseconds. */
  ts: number[];
  /** Cumulative net call premium at each `ts[i]`. */
  cumNcp: number[];
  /** Cumulative net put premium at each `ts[i]`. */
  cumNpp: number[];
}

type DbSql = ReturnType<typeof getDb>;
type DbNumeric = string | number | null;
type DbTimestamp = string | Date;

const num = (v: DbNumeric): number | null => (v == null ? null : Number(v));

/**
 * One-shot snapshot — issues a single SUM query against the session
 * window up to `fireTs`. Use for backfill or when only a handful of
 * fires per (ticker, date) are expected in a given run.
 */
export async function snapshotTickerFlowAtFire(
  db: DbSql,
  ticker: string,
  date: string,
  fireTs: Date,
): Promise<TickerFlowSnapshot> {
  const session = ctSessionBounds(date);
  const fireIso = fireTs.toISOString();
  const rows = (await db`
    SELECT
      SUM(net_call_prem) AS cum_ncp,
      SUM(net_put_prem)  AS cum_npp
    FROM (
      SELECT DISTINCT ON (ts) net_call_prem, net_put_prem
      FROM (
        SELECT ts, net_call_prem, net_put_prem, 1 AS priority
        FROM ws_net_flow_per_ticker
        WHERE ticker = ${ticker}
          AND ts >= ${session.min}::timestamptz
          AND ts <= ${fireIso}::timestamptz
        UNION ALL
        SELECT ts, net_call_prem, net_put_prem, 2 AS priority
        FROM net_flow_per_ticker_history
        WHERE ticker = ${ticker}
          AND ts >= ${session.min}::timestamptz
          AND ts <= ${fireIso}::timestamptz
      ) combined
      ORDER BY ts, priority
    ) unified
  `) as { cum_ncp: DbNumeric; cum_npp: DbNumeric }[];
  const row = rows[0];
  return {
    cumNcp: row ? num(row.cum_ncp) : null,
    cumNpp: row ? num(row.cum_npp) : null,
  };
}

/**
 * Fetch the full ticker-day cumulative series. Window-functions the
 * unified per-minute deltas into running totals so callers can later
 * binary-search for any fireTs without re-hitting the DB.
 *
 * Returns an empty series (all arrays length 0) if neither source has
 * any rows for the ticker on that date — `flowAtFireTime()` then
 * returns `{ cumNcp: null, cumNpp: null }`.
 */
export async function fetchTickerFlowSeries(
  db: DbSql,
  ticker: string,
  date: string,
): Promise<TickerFlowSeries> {
  const session = ctSessionBounds(date);
  const rows = (await db`
    WITH unified AS (
      SELECT DISTINCT ON (ts)
        ts, net_call_prem, net_put_prem
      FROM (
        SELECT ts, net_call_prem, net_put_prem, 1 AS priority
        FROM ws_net_flow_per_ticker
        WHERE ticker = ${ticker}
          AND ts >= ${session.min}::timestamptz
          AND ts <= ${session.max}::timestamptz
        UNION ALL
        SELECT ts, net_call_prem, net_put_prem, 2 AS priority
        FROM net_flow_per_ticker_history
        WHERE ticker = ${ticker}
          AND ts >= ${session.min}::timestamptz
          AND ts <= ${session.max}::timestamptz
      ) combined
      ORDER BY ts, priority
    )
    SELECT
      ts,
      SUM(net_call_prem) OVER (ORDER BY ts) AS cum_ncp,
      SUM(net_put_prem)  OVER (ORDER BY ts) AS cum_npp
    FROM unified
    ORDER BY ts
  `) as { ts: DbTimestamp; cum_ncp: DbNumeric; cum_npp: DbNumeric }[];

  const n = rows.length;
  const tsArr = new Array<number>(n);
  const ncpArr = new Array<number>(n);
  const nppArr = new Array<number>(n);
  for (let i = 0; i < n; i += 1) {
    const r = rows[i]!;
    tsArr[i] =
      typeof r.ts === 'string' ? Date.parse(r.ts) : r.ts.getTime();
    ncpArr[i] = Number(r.cum_ncp ?? 0);
    nppArr[i] = Number(r.cum_npp ?? 0);
  }
  return { ts: tsArr, cumNcp: ncpArr, cumNpp: nppArr };
}

/**
 * Binary-search the series for the snapshot at `fireTs` — returns the
 * cumulative totals at the largest `ts <= fireTs`. Returns `{ null, null }`
 * when the series is empty or `fireTs` precedes the earliest tick.
 */
export function flowAtFireTime(
  series: TickerFlowSeries,
  fireTs: Date,
): TickerFlowSnapshot {
  const target = fireTs.getTime();
  const { ts, cumNcp, cumNpp } = series;
  const n = ts.length;
  if (n === 0 || ts[0]! > target) {
    return { cumNcp: null, cumNpp: null };
  }
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (ts[mid]! <= target) lo = mid;
    else hi = mid - 1;
  }
  return { cumNcp: cumNcp[lo]!, cumNpp: cumNpp[lo]! };
}
