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
import { withDbRetry } from './db.js';
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
  const rows = (await withDbRetry(
    () => db`
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
    `,
    2,
    10_000,
  )) as { cum_ncp: DbNumeric; cum_npp: DbNumeric }[];
  const row = rows[0];
  return {
    cumNcp: row ? num(row.cum_ncp) : null,
    cumNpp: row ? num(row.cum_npp) : null,
  };
}

// How the detect crons bound the series fetch below, one place for both.
//
// A call gets at most FLOW_SERIES_DEADLINE_MS. The query reads one ticker's
// session (about 23,000 per-second rows) but the planner scans every ticker's
// rows for the day through the (ts) index, so it grows through the session:
// 1.1 s warm and 5.7–7.6 s on a cold compute (Neon EXPLAIN ANALYZE,
// 2026-11-14), which the old 5 s line cut off on 133 runs from 2026-10-29.
// The deadline abandons the query, it cannot cancel it, so a call is a single
// attempt: a retry would start a second copy after the caller gave up.
//
// Three stops keep a bad run from eating the crons' 60 s maxDuration, which
// the fires' INSERTs also have to fit in:
//   - the breaker: FLOW_BREAKER_FAILURES deadline or transient failures stop
//     the run asking (one slow ticker used to blank the rest of the run);
//   - the phase budget: FLOW_PHASE_BUDGET_MS is all the time a run spends
//     waiting on series, however many ticker-days it has. A call is not
//     started with less than FLOW_SERIES_MIN_DEADLINE_MS left, and one
//     started near the end gets only what is left;
//   - the run cutoff: FLOW_RUN_CUTOFF_MS is how far into the run a call may
//     still be waiting. The budget counts only the time spent on series, so a
//     setup that already ran long (the tick scan and seed query retry for up
//     to about 33 s) would push the whole phase past it. In lottery the
//     series are read in Pass 1, before the anchor lookup and every INSERT,
//     and a missed fire is not found again by the next run's window, so a
//     60 s kill there loses the tick's fires for good. A call that would end
//     after the cutoff is shortened to end at it, and none starts once less
//     than FLOW_SERIES_MIN_DEADLINE_MS of it is left.
// A run's flow phase is therefore at most 25 s and over by the 30 s mark. A
// healthy run starts it a few seconds in, so the cutoff costs it nothing; a
// run whose setup took 20 s gets 10 s, and one whose setup took 30 s or more
// asks for nothing and writes its fires without flow features, which the
// flow backfill and the re-score repair afterwards. The old rule capped one
// call at 5 s but not the sum, so nine slow answers just under it took 44 s.
export const FLOW_SERIES_DEADLINE_MS = 15_000;
export const FLOW_PHASE_BUDGET_MS = 25_000;
export const FLOW_RUN_CUTOFF_MS = 30_000;
export const FLOW_SERIES_MIN_DEADLINE_MS = 5_000;
export const FLOW_BREAKER_FAILURES = 2;

/**
 * The deadline for the next ticker-day's series, or null when the run should
 * stop asking (the breaker is open, the phase budget is spent, or the run is
 * too near FLOW_RUN_CUTOFF_MS). `failures` counts deadline and transient
 * failures so far in the run; `spentMs` is the time the run has spent waiting
 * on series; `runElapsedMs` is the time since the run started.
 */
export function nextFlowSeriesDeadlineMs(
  failures: number,
  spentMs: number,
  runElapsedMs: number,
): number | null {
  if (failures >= FLOW_BREAKER_FAILURES) return null;
  const leftMs = Math.min(
    FLOW_PHASE_BUDGET_MS - spentMs,
    FLOW_RUN_CUTOFF_MS - runElapsedMs,
  );
  if (leftMs < FLOW_SERIES_MIN_DEADLINE_MS) return null;
  return Math.min(FLOW_SERIES_DEADLINE_MS, leftMs);
}

/**
 * Fetch the full ticker-day cumulative series. Window-functions the
 * unified per-minute deltas into running totals so callers can later
 * binary-search for any fireTs without re-hitting the DB.
 *
 * Returns an empty series (all arrays length 0) if neither source has
 * any rows for the ticker on that date — `flowAtFireTime()` then
 * returns `{ cumNcp: null, cumNpp: null }`.
 *
 * One attempt, no retry and no per-attempt timeout: the caller bounds it
 * with `withDeadline` (see FLOW_SERIES_DEADLINE_MS above), and a retry would
 * start a second copy of the query after that deadline gave up on the first.
 * A Neon blip rejects with the driver's own error, which
 * `isRetryableDbError` still classifies as transient.
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
    tsArr[i] = typeof r.ts === 'string' ? Date.parse(r.ts) : r.ts.getTime();
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
