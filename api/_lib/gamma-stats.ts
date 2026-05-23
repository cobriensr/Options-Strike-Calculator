/**
 * Gamma-Node Composite Detector — rolling aggregation + drift detection.
 *
 * Pure(ish) functions consumed by:
 *  - api/gamma-setups/weekly-stats.ts (tile rolling-stats bar)
 *  - api/gamma-setups/export.ts (raw CSV export)
 *  - api/cron/check-gamma-setup-drift.ts (Friday drift alert)
 *
 * "Realized edge" semantics match the EOD backfill: ret_30m is already
 * direction-adjusted for the trade type (long_call/long_put/pcs), so a
 * positive value = trade was a winner regardless of signal type. Hit-rate
 * = fraction of fires with ret_30m > 0 (excluding NULLs which mean the
 * outcome hasn't been backfilled yet — typically fires from the current
 * trading day).
 *
 * Phase 3 spec: docs/superpowers/specs/gamma-node-composite-detector-2026-05-21.md
 */

import type { NeonQueryFunction } from '@neondatabase/serverless';

import { withDbRetry } from './db.js';
import type { SignalType } from './gamma-detector.js';

type Sql = NeonQueryFunction<false, false>;

// ============================================================
// EXPECTED EDGE (from the 82-day backtest, validated walk-forward)
// ============================================================

/**
 * Per-signal expected mean +30m edge (SPX points) from the brainstorm
 * round. Used by drift detection to flag live-vs-backtest divergence.
 *
 * Source numbers (project_gamma_node_detector_spec):
 *  - E1 long call: Δ=+5.36 pts (n=180, p=0.0007, walk-forward stable)
 *  - E5 long put:  Δ=+8.95 pts (n=86, walk-forward H1+10.98/H2+6.92)
 *  - PCS Monday:   Δ=+16.27 pts (n=45 in filter-on subset)
 */
export const EXPECTED_EDGE_PTS: Record<SignalType, number> = {
  e1_long_call: 5.36,
  e5_long_put: 8.95,
  pcs_monday: 16.27,
};

/** Sample-size floor before drift can fire — avoids spurious alerts on
 *  the first week or two of live data when n is tiny. */
export const DRIFT_MIN_N = 10;

/** Hit-rate floor for the composite; below this the cron emits a Sentry
 *  warning. The 55% threshold leaves 5pp of headroom under the 60% the
 *  user accepts as the strategy's lower bound. */
export const DRIFT_WIN_RATE_THRESHOLD = 0.55;

/** Mean-realized-edge ratio floor — when live mean ÷ expected drops
 *  below this, drift fires. 0.5 = the live edge is at half the backtest
 *  expectation; a sustained reading at that level is meaningful. */
export const DRIFT_EDGE_RATIO_THRESHOLD = 0.5;

// ============================================================
// TYPES
// ============================================================

interface FireStatsRow {
  signal_type: SignalType;
  ret_30m: string | number | null;
}

export interface PerSignalStats {
  signal_type: SignalType;
  n_total: number;
  n_with_outcome: number;
  n_winners: number;
  win_rate: number | null;
  mean_edge_pts: number | null;
  expected_edge_pts: number;
  edge_ratio: number | null;
}

export interface AggregateStats {
  /** Window start (inclusive) in ISO date string (YYYY-MM-DD). */
  from: string;
  /** Window end (inclusive) in ISO date string. */
  to: string;
  /** Total fires across all signal types within the window. */
  n_total: number;
  /** Fires whose ret_30m has been EOD-backfilled. */
  n_with_outcome: number;
  /** Aggregate winners (ret_30m > 0) across signal types. */
  n_winners: number;
  /** Composite win rate. null if n_with_outcome is 0. */
  win_rate: number | null;
  /** Composite mean realized edge (SPX pts). null if n_with_outcome is 0. */
  mean_edge_pts: number | null;
  /** Per-signal-type breakdown. */
  by_signal: PerSignalStats[];
}

export interface DriftDiagnostic {
  /** True when drift was detected — at least one rule fired. */
  fired: boolean;
  /** Specific rules that fired. */
  reasons: string[];
  /** Snapshot of the stats that drove the decision. */
  stats: AggregateStats;
}

// ============================================================
// PURE AGGREGATION
// ============================================================

const ALL_SIGNALS: ReadonlyArray<SignalType> = [
  'e1_long_call',
  'e5_long_put',
  'pcs_monday',
];

/**
 * Group raw fire rows by signal_type and compute per-signal stats. NULL
 * `ret_30m` means the EOD backfill hasn't run yet for that fire — those
 * rows count toward `n_total` but are excluded from win-rate and mean
 * calculations.
 */
export function aggregateFireStats(
  rows: ReadonlyArray<FireStatsRow>,
  windowFrom: string,
  windowTo: string,
): AggregateStats {
  const buckets = new Map<SignalType, FireStatsRow[]>();
  for (const s of ALL_SIGNALS) buckets.set(s, []);
  for (const row of rows) {
    const bucket = buckets.get(row.signal_type);
    if (bucket) bucket.push(row);
  }

  const bySignal: PerSignalStats[] = ALL_SIGNALS.map((sig) => {
    const sigRows = buckets.get(sig) ?? [];
    const withOutcome = sigRows.filter((r) => r.ret_30m != null);
    const winners = withOutcome.filter((r) => Number(r.ret_30m) > 0).length;
    const meanEdge =
      withOutcome.length > 0
        ? withOutcome.reduce((sum, r) => sum + Number(r.ret_30m), 0) /
          withOutcome.length
        : null;
    const winRate =
      withOutcome.length > 0 ? winners / withOutcome.length : null;
    const expected = EXPECTED_EDGE_PTS[sig];
    const edgeRatio =
      meanEdge != null && expected !== 0 ? meanEdge / expected : null;
    return {
      signal_type: sig,
      n_total: sigRows.length,
      n_with_outcome: withOutcome.length,
      n_winners: winners,
      win_rate: winRate,
      mean_edge_pts: meanEdge,
      expected_edge_pts: expected,
      edge_ratio: edgeRatio,
    };
  });

  const nTotal = rows.length;
  const allWithOutcome = rows.filter((r) => r.ret_30m != null);
  const allWinners = allWithOutcome.filter((r) => Number(r.ret_30m) > 0).length;
  const compositeMean =
    allWithOutcome.length > 0
      ? allWithOutcome.reduce((sum, r) => sum + Number(r.ret_30m), 0) /
        allWithOutcome.length
      : null;
  const compositeWinRate =
    allWithOutcome.length > 0 ? allWinners / allWithOutcome.length : null;

  return {
    from: windowFrom,
    to: windowTo,
    n_total: nTotal,
    n_with_outcome: allWithOutcome.length,
    n_winners: allWinners,
    win_rate: compositeWinRate,
    mean_edge_pts: compositeMean,
    by_signal: bySignal,
  };
}

/**
 * Apply drift-detection rules to an aggregate-stats snapshot. Returns
 * `null` when nothing fired so the caller can early-return; non-null
 * indicates at least one threshold breached and the cron should page.
 */
export function detectDrift(stats: AggregateStats): DriftDiagnostic | null {
  const reasons: string[] = [];

  // Rule 1 — composite win rate below floor (only meaningful with N>=10).
  if (
    stats.n_with_outcome >= DRIFT_MIN_N &&
    stats.win_rate != null &&
    stats.win_rate < DRIFT_WIN_RATE_THRESHOLD
  ) {
    reasons.push(
      `composite win rate ${(stats.win_rate * 100).toFixed(1)}% < ${(DRIFT_WIN_RATE_THRESHOLD * 100).toFixed(0)}% threshold ` +
        `(n=${stats.n_with_outcome})`,
    );
  }

  // Rule 2 — per-signal edge ratio collapsing.
  for (const sig of stats.by_signal) {
    if (
      sig.n_with_outcome >= DRIFT_MIN_N &&
      sig.edge_ratio != null &&
      sig.edge_ratio < DRIFT_EDGE_RATIO_THRESHOLD
    ) {
      const ratio = (sig.edge_ratio * 100).toFixed(0);
      reasons.push(
        `${sig.signal_type} edge ratio ${ratio}% < ${(DRIFT_EDGE_RATIO_THRESHOLD * 100).toFixed(0)}% ` +
          `(mean ${sig.mean_edge_pts?.toFixed(2)} vs expected ${sig.expected_edge_pts.toFixed(2)}, n=${sig.n_with_outcome})`,
      );
    }
  }

  if (reasons.length === 0) return null;
  return { fired: true, reasons, stats };
}

// ============================================================
// DB LOADERS
// ============================================================

/**
 * Pull just the columns needed for aggregation (signal_type + ret_30m)
 * over a date range. Excludes future-dated rows defensively. Uses the
 * `idx_ws_gamma_setup_fires_fired_at` index for the bounded scan.
 */
export async function loadFireStatsRows(
  sql: Sql,
  windowFrom: string,
  windowTo: string,
): Promise<FireStatsRow[]> {
  return (await withDbRetry(
    () => sql`
      SELECT signal_type, ret_30m
      FROM ws_gamma_setup_fires
      WHERE fired_at >= ${windowFrom}::date
        AND fired_at < (${windowTo}::date + INTERVAL '1 day')
      ORDER BY fired_at ASC
    `,
    2,
    10_000,
  )) as FireStatsRow[];
}

/**
 * Full export query — every column on `ws_gamma_setup_fires` plus a
 * computed `is_winner` flag for spreadsheet pivot tables. Caller decides
 * whether to render as CSV or JSON. Returns a fairly wide row shape so
 * we keep it as `Record<string, unknown>[]` and let the response
 * normalizer flatten Date/Numeric columns.
 */
export async function loadFiresForExport(
  sql: Sql,
  windowFrom: string,
  windowTo: string,
): Promise<Record<string, unknown>[]> {
  return (await withDbRetry(
    () => sql`
      SELECT
        id,
        fired_at,
        signal_type,
        dow_label,
        confidence_tier,
        spot_at_fire,
        node_strike,
        node_gex,
        bar_open,
        bar_high,
        bar_low,
        bar_close,
        bar_range,
        es_basis_change_5m,
        prior_5d_ret,
        prior_iv_rank,
        pre_day_filter_fires,
        open_gap_pct,
        is_fomc_day,
        is_dom_1_5,
        is_dom_16_20,
        ret_15m,
        ret_30m,
        ret_60m,
        ret_eod,
        CASE
          WHEN ret_30m IS NULL THEN NULL
          WHEN ret_30m > 0 THEN TRUE
          ELSE FALSE
        END AS is_winner,
        trade_taken,
        trade_premium_cost,
        trade_premium_close,
        trade_pnl_dollars,
        trade_notes,
        inserted_at
      FROM ws_gamma_setup_fires
      WHERE fired_at >= ${windowFrom}::date
        AND fired_at < (${windowTo}::date + INTERVAL '1 day')
      ORDER BY fired_at ASC
    `,
    2,
    10_000,
  )) as Record<string, unknown>[];
}
