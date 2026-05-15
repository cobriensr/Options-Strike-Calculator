/**
 * Read helper for the Pin-Setup Tile
 * (Phase 1 of docs/superpowers/specs/pin-setup-widget-2026-05-14.md).
 *
 * Two modes:
 *
 *   1. **Live** (`date = null`) — latest available 0DTE snapshot.
 *   2. **Historical** (`date = YYYY-MM-DD`) — the first 0DTE row at or
 *      after 09:30 CT on that calendar date. Also returns the day's
 *      settle (last cash-session SPX 1m close) for backtest outcome
 *      scoring.
 *
 * Read-only; ingestion is owned by `api/cron/fetch-gex-0dte.ts` and
 * `api/cron/fetch-spot-gex.ts`.
 */

import { getDb } from './db.js';

type NumericFromDb = string | number | null;

interface RawStrikeRow {
  strike: string | number;
  spot: NumericFromDb;
  net_gamma_raw: NumericFromDb;
  net_charm_raw: NumericFromDb;
  snapshot_ts: string | Date;
}

interface RawTrajRow {
  ts: string | Date;
  price: NumericFromDb;
  gamma_dir: NumericFromDb;
}

interface RawSettleRow {
  close: NumericFromDb;
}

export interface PinSetupStrike {
  strike: number;
  /** Net gamma in millions (raw column / 1e6). */
  netGammaM: number;
  /** Net charm in millions. */
  netCharmM: number;
}

export interface PinSetupTrajectoryPoint {
  /** ISO UTC timestamp of the sample. */
  ts: string;
  /** SPX spot at the sample (may be null if missing in source). */
  spot: number | null;
  /** Dealer gamma_dir in millions. */
  gammaDirM: number;
}

export interface PinSetupSnapshot {
  /** ISO timestamp of the gex_strike_0dte row used. */
  snapshotTs: string | null;
  /** Spot price recorded on the snapshot. */
  spot: number | null;
  /** Top strikes ordered by abs(net gamma) desc. */
  strikes: PinSetupStrike[];
  /** Intraday gamma_dir trajectory for the same session. */
  trajectory: PinSetupTrajectoryPoint[];
  /** Settle (last cash-session close) for historical mode only. */
  settle: number | null;
}

function toIso(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function toNum(value: NumericFromDb): number {
  if (value == null) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toNumOrNull(value: NumericFromDb): number | null {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Get the latest (or historical) pin-setup snapshot.
 *
 * @param date Optional `YYYY-MM-DD` calendar date for historical mode.
 *             When supplied, returns the first snapshot at or after
 *             09:30 CT on that date plus the day's settle.
 */
export async function getLatestPinSetup(
  date: string | null = null,
): Promise<PinSetupSnapshot> {
  const sql = getDb();

  // 1) Pick the snapshot timestamp:
  //    - live: latest gex_strike_0dte timestamp (last 5 days bounded).
  //      Stale-tolerant on purpose — pre-market / weekend show the
  //      previous session's chain as informational context. The
  //      endpoint exposes `staleMinutes` so the frontend can render
  //      a staleness indicator and the rule state is interpreted
  //      against current freshness, not silently against stale data.
  //    - historical: end-of-session snapshot for the target CT date.
  //      Filters by the CT date of the *timestamp* (not the row's
  //      `date` column) because the cron has historically mis-tagged
  //      some rows' `date` column with the next session's date — using
  //      the timestamp-derived CT date is bug-proof against that.
  //      We show EOD rather than 09:30 CT because the +γ wall builds
  //      continuously through the day; users reviewing past sessions
  //      want to know whether the day ended up as a pin (peak wall
  //      strength + final settle), not where the wall was at the
  //      first informative read.
  const snapTsRows = date
    ? ((await sql`
        SELECT MAX(timestamp) AS ts
        FROM gex_strike_0dte
        WHERE (timestamp AT TIME ZONE 'US/Central')::date = ${date}::date
          AND (timestamp AT TIME ZONE 'US/Central')::time
                BETWEEN TIME '08:30' AND TIME '15:30'
      `) as Array<{ ts: string | Date | null }>)
    : ((await sql`
        SELECT MAX(timestamp) AS ts
        FROM gex_strike_0dte
        WHERE timestamp >= NOW() - INTERVAL '5 days'
      `) as Array<{ ts: string | Date | null }>);

  const tsValue = snapTsRows[0]?.ts;
  if (!tsValue) {
    return {
      snapshotTs: null,
      spot: null,
      strikes: [],
      trajectory: [],
      settle: null,
    };
  }
  const snapshotTs = toIso(tsValue);

  // 2) Per-strike rows at that snapshot.
  const strikeRows = (await sql`
    SELECT
      strike                                AS strike,
      price                                 AS spot,
      (call_gamma_oi + put_gamma_oi)        AS net_gamma_raw,
      (call_charm_oi + put_charm_oi)        AS net_charm_raw,
      timestamp                             AS snapshot_ts
    FROM gex_strike_0dte
    WHERE timestamp = ${snapshotTs}::timestamptz
    ORDER BY ABS(call_gamma_oi + put_gamma_oi) DESC
    LIMIT 25
  `) as RawStrikeRow[];

  if (strikeRows.length === 0) {
    return {
      snapshotTs,
      spot: null,
      strikes: [],
      trajectory: [],
      settle: null,
    };
  }

  const spot = toNumOrNull(strikeRows[0]!.spot);
  const strikes: PinSetupStrike[] = strikeRows.map((r) => ({
    strike: toNum(r.strike),
    netGammaM: toNum(r.net_gamma_raw) / 1e6,
    netCharmM: toNum(r.net_charm_raw) / 1e6,
  }));

  // 3) Trajectory for the session (08:30–15:00 CT) of the same date.
  //    ORDER BY timestamp DESC + reverse in JS so we never lose the
  //    most-recent samples to a LIMIT clamp. Cap at 600 to comfortably
  //    cover a 6.5h session at 1-min cadence with backfill headroom.
  //    Session date is derived from the snapshot timestamp itself
  //    (CT date) rather than the row's `date` column, defensively
  //    matching the snapshot-pick logic.
  const trajRows = (await sql`
    SELECT
      timestamp  AS ts,
      price      AS price,
      gamma_dir  AS gamma_dir
    FROM spot_exposures
    WHERE ticker = 'SPX'
      AND (timestamp AT TIME ZONE 'US/Central')::date =
            (${snapshotTs}::timestamptz AT TIME ZONE 'US/Central')::date
      AND (timestamp AT TIME ZONE 'US/Central')::time
            BETWEEN TIME '08:30' AND TIME '15:00'
    ORDER BY timestamp DESC
    LIMIT 600
  `) as RawTrajRow[];

  const trajectory: PinSetupTrajectoryPoint[] = trajRows
    .slice()
    .reverse()
    .map((r) => ({
      ts: toIso(r.ts),
      spot: toNumOrNull(r.price),
      gammaDirM: toNum(r.gamma_dir) / 1e6,
    }));

  // 4) Settle (historical mode only). Last cash-session SPX 1m close
  //    on the target CT date. Filters by the CT date of the timestamp
  //    (not `date` column) to defend against the same cron mis-tagging
  //    that breaks the snapshot-pick query.
  let settle: number | null = null;
  if (date) {
    const settleRows = (await sql`
      SELECT close
      FROM index_candles_1m
      WHERE symbol = 'SPX'
        AND (timestamp AT TIME ZONE 'US/Central')::date = ${date}::date
        AND (timestamp AT TIME ZONE 'US/Central')::time <= TIME '15:00'
      ORDER BY timestamp DESC
      LIMIT 1
    `) as RawSettleRow[];
    settle = toNumOrNull(settleRows[0]?.close ?? null);
  }

  return { snapshotTs, spot, strikes, trajectory, settle };
}
