/**
 * Per-ticker inversion-quality refit for `lottery_ticker_stats`.
 *
 * TypeScript port of `refit_ticker_inversion_stats` in
 * scripts/enrich_lottery_outcomes.py (the local nightly that last refit the
 * table on 2026-06-17). Same window counts, same Wilson 95% lower bound with
 * an N >= 10 floor, same 0.6 x 21d + 0.4 x 90d blend, same rank quintiles
 * with (blend, ticker) tie order, so a shadow run and the Python run agree
 * on identical inputs.
 *
 * The inputs are `realized_flow_inversion_pct` on lottery_finder_fires, a
 * fire "wins" at >= INVERSION_WIN_THRESHOLD %. The quintile drives Q1/Q2
 * suppression (lottery-suppression.ts) and the score bonus
 * (lottery-inversion-bonus.ts).
 *
 * Spec: docs/superpowers/specs/lottery-enrichment-starvation-2026-10-02.md
 *       docs/superpowers/specs/lottery-inversion-quality-filter-2026-05-19.md
 */

import { withDbRetry, type getDb } from './db.js';

type Sql = ReturnType<typeof getDb>;
type DbNumeric = string | number;

/** realized_flow_inversion_pct >= 50 counts as a win. */
export const INVERSION_WIN_THRESHOLD = 50;
/** A window with fewer resolved fires has no Wilson bound (NULL). */
export const SAMPLE_SIZE_FLOOR = 10;
const WILSON_Z = 1.96;
const WINDOW_WEIGHT_21D = 0.6;
const WINDOW_WEIGHT_90D = 0.4;

/** Wilson 95% lower confidence bound on P(win); NULL below the floor. */
export function wilsonLcb(wins: number, n: number): number | null {
  if (n < SAMPLE_SIZE_FLOOR || n <= 0) return null;
  const p = wins / n;
  const z = WILSON_Z;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (center - margin) / denom);
}

/** 0.6 x 21d + 0.4 x 90d when both exist, else whichever exists, else NULL. */
export function inversionBlend(
  lcb21d: number | null,
  lcb90d: number | null,
): number | null {
  if (lcb21d !== null && lcb90d !== null) {
    return WINDOW_WEIGHT_21D * lcb21d + WINDOW_WEIGHT_90D * lcb90d;
  }
  return lcb21d ?? lcb90d;
}

/** Code-point string order, like Python's str comparison. */
const byCodePoint = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/**
 * Rank quintiles 1 (worst blend) .. 5 (best) over the non-NULL blends.
 * Ties order by ticker so a rerun on the same data never reshuffles. A
 * single ticker is quintile 1. NULL blends get no quintile.
 */
export function quintileCuts(
  blends: ReadonlyMap<string, number | null>,
): Map<string, number> {
  const ordered = [...blends]
    .filter((e): e is [string, number] => e[1] !== null)
    .sort((a, b) => a[1] - b[1] || byCodePoint(a[0], b[0]));
  const out = new Map<string, number>();
  const n = ordered.length;
  if (n === 1) {
    out.set(ordered[0]![0], 1);
    return out;
  }
  ordered.forEach(([ticker], rank) => {
    const q = rank < n - 1 ? Math.floor((rank * 5) / (n - 1)) + 1 : 5;
    out.set(ticker, Math.min(q, 5));
  });
  return out;
}

/** Per-ticker resolved (n) and winning (w) fire counts per window. */
export interface TickerWindowCounts {
  ticker: string;
  n21d: number;
  w21d: number;
  n90d: number;
  w90d: number;
}

const isCount = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * Window counts over the last 90 days of fires, as the Python refit reads
 * them. A malformed row throws: stats must never be fit on garbage.
 */
export async function readTickerWindowCounts(
  sql: Sql,
): Promise<TickerWindowCounts[]> {
  const rows = (await withDbRetry(
    () => sql`
      SELECT underlying_symbol AS ticker,
             (count(*) FILTER (
                WHERE trigger_time_ct >= NOW() - INTERVAL '21 days'
                  AND realized_flow_inversion_pct IS NOT NULL))::int AS "n21d",
             (count(*) FILTER (
                WHERE trigger_time_ct >= NOW() - INTERVAL '21 days'
                  AND realized_flow_inversion_pct >= ${INVERSION_WIN_THRESHOLD}))::int AS "w21d",
             (count(*) FILTER (
                WHERE realized_flow_inversion_pct IS NOT NULL))::int AS "n90d",
             (count(*) FILTER (
                WHERE realized_flow_inversion_pct >= ${INVERSION_WIN_THRESHOLD}))::int AS "w90d"
        FROM lottery_finder_fires
       WHERE date >= ((NOW() - INTERVAL '90 days') AT TIME ZONE 'America/New_York')::date
         AND trigger_time_ct >= NOW() - INTERVAL '90 days'
       GROUP BY underlying_symbol
    `,
    2,
    30_000,
  )) as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const { ticker, n21d, w21d, n90d, w90d } = r;
    if (
      typeof ticker !== 'string' ||
      !isCount(n21d) ||
      !isCount(w21d) ||
      !isCount(n90d) ||
      !isCount(w90d) ||
      w21d > n21d ||
      w90d > n90d ||
      n21d > n90d
    ) {
      throw new Error(
        `refit-lottery-ticker-stats: malformed window counts ${JSON.stringify(r)}`,
      );
    }
    return { ticker, n21d, w21d, n90d, w90d };
  });
}

/** The would-be inversion columns for one ticker. */
export interface TickerInversionStats {
  ticker: string;
  lcb21d: number | null;
  lcb90d: number | null;
  blend: number | null;
  quintile: number | null;
  n21d: number;
  n90d: number;
}

/** Wilson bounds + blend per ticker, then quintiles across tickers. */
export function computeTickerInversionStats(
  counts: readonly TickerWindowCounts[],
): TickerInversionStats[] {
  const partial = counts.map((c) => {
    const lcb21d = wilsonLcb(c.w21d, c.n21d);
    const lcb90d = wilsonLcb(c.w90d, c.n90d);
    return {
      ticker: c.ticker,
      lcb21d,
      lcb90d,
      blend: inversionBlend(lcb21d, lcb90d),
      n21d: c.n21d,
      n90d: c.n90d,
    };
  });
  const quintiles = quintileCuts(
    new Map(partial.map((s) => [s.ticker, s.blend])),
  );
  return partial
    .map((s) => ({ ...s, quintile: quintiles.get(s.ticker) ?? null }))
    .sort((a, b) => byCodePoint(a.ticker, b.ticker));
}

/** The frozen live inversion columns of lottery_ticker_stats. */
export interface LiveTickerStats {
  ticker: string;
  quintile: number | null;
  blend: number | null;
  updatedAt: string | null;
}

export async function readLiveTickerStats(
  sql: Sql,
): Promise<LiveTickerStats[]> {
  const rows = (await withDbRetry(
    () => sql`
      SELECT ticker,
             inversion_quintile AS quintile,
             inversion_blend::float8 AS blend,
             updated_at AS "updatedAt"
        FROM lottery_ticker_stats
    `,
    2,
    10_000,
  )) as Array<{
    ticker: string;
    quintile: DbNumeric | null;
    blend: DbNumeric | null;
    updatedAt: string | Date | null;
  }>;
  return rows.map((r) => ({
    ticker: r.ticker,
    quintile: r.quintile == null ? null : Number(r.quintile),
    blend: r.blend == null ? null : Number(r.blend),
    updatedAt: r.updatedAt == null ? null : new Date(r.updatedAt).toISOString(),
  }));
}

export interface QuintileChange {
  ticker: string;
  live: number | null;
  shadow: number | null;
  liveBlend: number | null;
  shadowBlend: number | null;
  n21d: number;
  n90d: number;
}

/** Coverage of the would-be stats and their diff against the live table. */
export interface ShadowRefitReport {
  /** Tickers with any fire in the 90-day window (the refit's universe). */
  tickersSeen: number;
  /** Tickers with a blend, i.e. >= SAMPLE_SIZE_FLOOR resolved fires in a window. */
  tickersWithBlend: number;
  tickersAtFloor21d: number;
  tickersAtFloor90d: number;
  /** Fires with a realized inversion, summed over tickers. */
  resolvedFires21d: number;
  resolvedFires90d: number;
  /** Shadow quintile -> ticker count. */
  shadowQuintiles: Record<string, number>;
  live: { rows: number; withQuintile: number; lastUpdatedAt: string | null };
  /**
   * Over tickers in BOTH sets (what an UPDATE-only write would touch):
   * same quintile / different / live set -> NULL / live NULL -> set.
   * notInLiveTable: refit tickers the UPDATE-only write would skip.
   * liveNotRefit: live rows with no fire in 90 d (left as they are).
   */
  diff: {
    unchanged: number;
    changed: number;
    wouldClear: number;
    wouldSet: number;
    notInLiveTable: number;
    liveNotRefit: number;
  };
  /** Every ticker whose quintile would change. */
  changes: QuintileChange[];
}

export function buildShadowReport(
  stats: readonly TickerInversionStats[],
  live: readonly LiveTickerStats[],
): ShadowRefitReport {
  const liveByTicker = new Map(live.map((l) => [l.ticker, l]));
  const shadowTickers = new Set(stats.map((s) => s.ticker));
  const shadowQuintiles: Record<string, number> = {};
  const diff = {
    unchanged: 0,
    changed: 0,
    wouldClear: 0,
    wouldSet: 0,
    notInLiveTable: 0,
    liveNotRefit: live.filter((l) => !shadowTickers.has(l.ticker)).length,
  };
  const changes: QuintileChange[] = [];

  for (const s of stats) {
    if (s.quintile !== null) {
      const key = String(s.quintile);
      shadowQuintiles[key] = (shadowQuintiles[key] ?? 0) + 1;
    }
    const l = liveByTicker.get(s.ticker);
    if (l === undefined) {
      diff.notInLiveTable += 1;
      continue;
    }
    if (l.quintile === s.quintile) {
      diff.unchanged += 1;
      continue;
    }
    if (s.quintile === null) diff.wouldClear += 1;
    else if (l.quintile === null) diff.wouldSet += 1;
    else diff.changed += 1;
    changes.push({
      ticker: s.ticker,
      live: l.quintile,
      shadow: s.quintile,
      liveBlend: l.blend,
      shadowBlend: s.blend,
      n21d: s.n21d,
      n90d: s.n90d,
    });
  }

  const updatedAts = live
    .map((l) => l.updatedAt)
    .filter((u): u is string => u !== null)
    .sort(byCodePoint);
  return {
    tickersSeen: stats.length,
    tickersWithBlend: stats.filter((s) => s.blend !== null).length,
    tickersAtFloor21d: stats.filter((s) => s.n21d >= SAMPLE_SIZE_FLOOR).length,
    tickersAtFloor90d: stats.filter((s) => s.n90d >= SAMPLE_SIZE_FLOOR).length,
    resolvedFires21d: stats.reduce((n, s) => n + s.n21d, 0),
    resolvedFires90d: stats.reduce((n, s) => n + s.n90d, 0),
    shadowQuintiles,
    live: {
      rows: live.length,
      withQuintile: live.filter((l) => l.quintile !== null).length,
      lastUpdatedAt: updatedAts.at(-1) ?? null,
    },
    diff,
    changes,
  };
}

/**
 * The LIVE write (the promotion path; the shadow cron never calls it while
 * PROMOTE_TO_LIVE is false). UPDATE-only, like the Python refit: the table
 * has legacy NOT NULL columns this refit does not own, so tickers missing
 * from it are skipped (lottery-ticker-stats-seed.ts seeds them). Refuses to
 * run when no ticker has a quintile: that write would clear every quintile
 * and switch Q1/Q2 suppression off fleet-wide (the 2026-10 state, when the
 * inputs had been empty since June). Returns the number of rows written.
 */
export async function writeLiveTickerStats(
  sql: Sql,
  stats: readonly TickerInversionStats[],
): Promise<number> {
  if (!stats.some((s) => s.quintile !== null)) {
    throw new Error(
      'refit-lottery-ticker-stats: refusing a live write with no quintile ' +
        '(it would clear every inversion quintile)',
    );
  }
  const rows = (await withDbRetry(
    () => sql`
      UPDATE lottery_ticker_stats AS t
         SET inversion_lcb_21d = u.lcb21d,
             inversion_lcb_90d = u.lcb90d,
             inversion_blend = u.blend,
             inversion_quintile = u.quintile,
             inversion_n_21d = u.n21d,
             inversion_n_90d = u.n90d,
             updated_at = NOW()
        FROM unnest(
               ${stats.map((s) => s.ticker)}::text[],
               ${stats.map((s) => s.lcb21d)}::float8[],
               ${stats.map((s) => s.lcb90d)}::float8[],
               ${stats.map((s) => s.blend)}::float8[],
               ${stats.map((s) => s.quintile)}::smallint[],
               ${stats.map((s) => s.n21d)}::int[],
               ${stats.map((s) => s.n90d)}::int[]
             ) AS u(ticker, lcb21d, lcb90d, blend, quintile, n21d, n90d)
       WHERE t.ticker = u.ticker
      RETURNING t.ticker
    `,
    2,
    30_000,
  )) as Array<{ ticker: string }>;
  return rows.length;
}
