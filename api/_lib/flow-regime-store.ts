/**
 * Flow Regime Recognition — snapshot store.
 *
 * Reads the LATEST captured per-(date, slot) row from the
 * `flow_regime_snapshots` table (migration #185) and shapes it for the
 * `GET /api/flow-regime` endpoint. The capture-flow-regime cron
 * (api/cron/capture-flow-regime.ts) writes one row per 30-min RTH slot
 * every 5 min during market hours, refining the in-progress slot via
 * ON CONFLICT (date, slot) DO UPDATE.
 *
 * The badge consumes only the latest slot, so the store fetches only the
 * highest slot for the date (LIMIT 1) rather than the full 13-slot series.
 *
 * RECOGNITION ONLY — these snapshots score the current intraday flow
 * against the SAME time-of-day bucket historically; they do NOT
 * forecast direction.
 *
 * Phase 2 of docs/superpowers/specs/flow-regime-badge-2026-06-06.md
 */
import { getDb } from './db.js';
import { numOrNull } from './numeric-coercion.js';
import { neonDateStr, neonIso } from './db-date.js';
import type { FlowRegime, FlowRegimeColor } from './flow-regime.js';

/**
 * Raw shape of one row from Neon. The HTTP driver returns:
 *   - DATE columns as JS `Date` objects
 *   - TIMESTAMPTZ columns as ISO strings
 *   - NUMERIC columns as strings (precision preserved as text)
 *   - INT columns as JS numbers
 */
interface FlowRegimeSnapshotRow {
  date: string | Date;
  slot: number;
  computed_at: string | Date;
  nd_tilt: string | null;
  idx0dte_put_share: string | null;
  nd_percentile: string | null;
  idxput_percentile: string | null;
  regime: string | null;
  color: string | null;
  n_trades: number | null;
  baseline_version: number | null;
}

/** Public, fully-coerced snapshot shape returned by the endpoint. */
export interface FlowRegimeSnapshot {
  date: string;
  slot: number;
  computedAt: string;
  ndTilt: number | null;
  idx0dtePutShare: number | null;
  ndPercentile: number | null;
  idxputPercentile: number | null;
  regime: FlowRegime;
  color: FlowRegimeColor;
  nTrades: number;
  /** Baseline artifact schema_version this snapshot was scored against. */
  baselineVersion: number | null;
}

function rowToSnapshot(r: FlowRegimeSnapshotRow): FlowRegimeSnapshot {
  return {
    date: neonDateStr(r.date),
    slot: r.slot,
    computedAt: neonIso(r.computed_at),
    ndTilt: numOrNull(r.nd_tilt),
    idx0dtePutShare: numOrNull(r.idx0dte_put_share),
    ndPercentile: numOrNull(r.nd_percentile),
    idxputPercentile: numOrNull(r.idxput_percentile),
    // Stored as TEXT — fall back to the recognition default ('normal'/'gray')
    // for legacy or partially-written rows so the UI never sees a null badge.
    regime: (r.regime ?? 'normal') as FlowRegime,
    color: (r.color ?? 'gray') as FlowRegimeColor,
    nTrades: r.n_trades ?? 0,
    baselineVersion: numOrNull(r.baseline_version),
  };
}

/**
 * Read the latest captured slot snapshot for a single ET trading date (the
 * highest slot present — the in-progress / most-recent bucket). Returns a null
 * latest when the cron has not yet written for `date`.
 */
export async function readFlowRegimeDay(date: string): Promise<{
  date: string;
  latest: FlowRegimeSnapshot | null;
}> {
  const sql = getDb();
  const rows = (await sql`
    SELECT
      date,
      slot,
      computed_at,
      nd_tilt,
      idx0dte_put_share,
      nd_percentile,
      idxput_percentile,
      regime,
      color,
      n_trades,
      baseline_version
    FROM flow_regime_snapshots
    WHERE date = ${date}::date
    ORDER BY slot DESC
    LIMIT 1
  `) as FlowRegimeSnapshotRow[];

  const first = rows[0];
  return { date, latest: first ? rowToSnapshot(first) : null };
}
