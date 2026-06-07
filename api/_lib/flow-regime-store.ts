/**
 * Flow Regime Recognition — snapshot store.
 *
 * Reads previously captured per-(date, slot) rows from the
 * `flow_regime_snapshots` table (migration #185) and shapes them for
 * the `GET /api/flow-regime` endpoint. The capture-flow-regime cron
 * (api/cron/capture-flow-regime.ts) writes one row per 30-min RTH slot
 * every 5 min during market hours, refining the in-progress slot via
 * ON CONFLICT (date, slot) DO UPDATE.
 *
 * RECOGNITION ONLY — these snapshots score the current intraday flow
 * against the SAME time-of-day bucket historically; they do NOT
 * forecast direction.
 *
 * Phase 2 of docs/superpowers/specs/flow-regime-badge-2026-06-06.md
 */
import { getDb } from './db.js';
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
}

function toIso(v: string | Date): string {
  return typeof v === 'string' ? v : v.toISOString();
}

function toDateStr(v: string | Date): string {
  return typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10);
}

/** Coerce a Neon NUMERIC (string | null) to number | null. */
function numOrNull(v: string | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function rowToSnapshot(r: FlowRegimeSnapshotRow): FlowRegimeSnapshot {
  return {
    date: toDateStr(r.date),
    slot: r.slot,
    computedAt: toIso(r.computed_at),
    ndTilt: numOrNull(r.nd_tilt),
    idx0dtePutShare: numOrNull(r.idx0dte_put_share),
    ndPercentile: numOrNull(r.nd_percentile),
    idxputPercentile: numOrNull(r.idxput_percentile),
    // Stored as TEXT — fall back to the recognition default ('normal'/'gray')
    // for legacy or partially-written rows so the UI never sees a null badge.
    regime: (r.regime ?? 'normal') as FlowRegime,
    color: (r.color ?? 'gray') as FlowRegimeColor,
    nTrades: r.n_trades ?? 0,
  };
}

/**
 * Read all captured slot snapshots for a single ET trading date,
 * ordered by slot ascending (the slot series the badge renders), plus
 * the latest/current snapshot (highest slot present). Returns an empty
 * series + null latest when the cron has not yet written for `date`.
 */
export async function readFlowRegimeDay(date: string): Promise<{
  date: string;
  slots: FlowRegimeSnapshot[];
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
      n_trades
    FROM flow_regime_snapshots
    WHERE date = ${date}::date
    ORDER BY slot ASC
  `) as FlowRegimeSnapshotRow[];

  const slots = rows.map(rowToSnapshot);
  // Latest = the highest slot captured today (the in-progress / most
  // recent bucket). slots is slot-ascending so `.at(-1)` is the latest.
  const latest = slots.at(-1) ?? null;

  return { date, slots, latest };
}
