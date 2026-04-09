/**
 * GexTarget feature-row helper (Phase 4, subagent 4A).
 *
 * This module is the shared bridge between the three-layer data architecture
 * (raw → features → scoring) and the `gex_target_features` table. The live
 * `fetch-gex-0dte` cron and the 30-day backfill script both import these
 * two functions so the online and historical feature rows are produced by
 * the exact same code path:
 *
 *   Layer 1 (raw)       — `gex_strike_0dte` rows from the UW API
 *   Layer 2 (features)  — per-strike MagnetFeatures (deltas, call ratio,
 *                         charm / DEX / VEX, dist-from-spot, minutes since
 *                         noon CT)
 *   Layer 3 (scoring)   — StrikeScore per mode (component scores +
 *                         composite + tier + wall side)
 *
 * Both layers are flattened into one row per `(timestamp, mode, strike)`
 * tuple and written with a single multi-row INSERT that uses
 * `ON CONFLICT (date, timestamp, mode, strike, math_version) DO NOTHING`
 * to stay idempotent with the backfill.
 *
 * Error-handling philosophy — feature writes are NON-BLOCKING for the
 * cron. The raw snapshot write has already been committed by the time
 * this helper runs; if `computeGexTarget` throws, if the SQL insert
 * fails, or if the feature universe is empty, we log and return zeros
 * rather than propagating the error. The raw data pipeline must remain
 * resilient even if the scoring math has bugs, so a feature-write
 * regression never causes lost `gex_strike_0dte` rows.
 *
 * DEX and VEX are stored in Layer 2 (`delta_net`, `vanna_net`) but
 * deliberately NOT scored in v1 (see Appendix I of the plan doc) — they
 * are reserved for a future `math_version = 'v2'` bump.
 */

import { getDb } from './db.js';
import logger from './logger.js';
import {
  GEX_TARGET_CONFIG,
  computeGexTarget,
  type GexSnapshot,
  type GexStrikeRow,
  type Mode,
  type StrikeScore,
  type TargetScore,
} from '../../src/utils/gex-target.js';

// ── Types ───────────────────────────────────────────────────────────────

/**
 * Summary of what `writeFeatureRows` actually wrote to the database.
 * Per-mode breakdowns are reported separately so the cron log can tell
 * at a glance which mode(s) produced data on a given snapshot.
 */
export interface WriteFeatureRowsResult {
  written: number;
  skipped: number;
  modes: {
    oi: { written: number; skipped: number };
    vol: { written: number; skipped: number };
    dir: { written: number; skipped: number };
  };
}

/**
 * Board-level nearest-wall metadata. These four fields are computed at
 * the mode universe level (not per-strike) and stamped onto every row
 * in the same snapshot × mode. The Phase 1 math module does not produce
 * them — they were added to the schema for Appendix B futures-validation
 * experiments, so this helper is responsible for filling them.
 */
interface NearestWallContext {
  posDist: number | null;
  posGex: number | null;
  negDist: number | null;
  negGex: number | null;
}

// The `gex_strike_0dte` row shape as returned by the Neon driver (all
// numeric columns come back as strings). Timestamps arrive as Date
// objects from the Neon driver but we coerce defensively below.
interface RawStrikeRow {
  timestamp: string | Date;
  strike: string;
  price: string;
  call_gamma_oi: string | null;
  put_gamma_oi: string | null;
  call_gamma_vol: string | null;
  put_gamma_vol: string | null;
  call_gamma_ask: string | null;
  call_gamma_bid: string | null;
  put_gamma_ask: string | null;
  put_gamma_bid: string | null;
  call_charm_oi: string | null;
  put_charm_oi: string | null;
  call_charm_vol: string | null;
  put_charm_vol: string | null;
  call_delta_oi: string | null;
  put_delta_oi: string | null;
  call_vanna_oi: string | null;
  put_vanna_oi: string | null;
  call_vanna_vol: string | null;
  put_vanna_vol: string | null;
}

// Number of columns inserted per row — keep this in sync with both the
// INSERT column list (buildInsertSql) and the row-flattening params
// pushed by pushRowParams. Breakdown:
//   5  identity     (date, timestamp, mode, math_version, strike)
//   3  ranking      (rank_in_mode, rank_by_size, is_target)
//   1  gex_dollars
//   4  delta_gex_*
//   4  prev_gex_dollars_*
//   4  delta_pct_*
//   4  call_ratio, charm_net, delta_net, vanna_net
//   3  dist_from_spot, spot_price, minutes_after_noon_ct
//   4  nearest-wall (pos_dist, pos_gex, neg_dist, neg_gex)
//   6  component scores
//   3  final_score, tier, wall_side
// Total: 41
const COLUMNS_PER_ROW = 41;

// ── loadSnapshotHistory ─────────────────────────────────────────────────

/**
 * Load the last `historySize` snapshots from `gex_strike_0dte` up to and
 * including `asOfTimestamp`, reshape the flat per-strike rows into
 * `GexSnapshot` objects, and return them sorted ascending by timestamp
 * (latest LAST) — which is the ordering `computeGexTarget` expects.
 *
 * Returns an empty array when:
 *  - the DB query returns no rows
 *  - every candidate timestamp is dropped during defensive validation
 *
 * Defensive behavior: if an individual timestamp's rows have bad price
 * data or an unparsable strike, that whole timestamp is logged and
 * skipped rather than crashing the helper.
 */
export async function loadSnapshotHistory(
  date: string,
  asOfTimestamp: string,
  historySize: number,
): Promise<GexSnapshot[]> {
  if (historySize <= 0) return [];

  const sql = getDb();

  // Pull up to historySize * 500 strike rows: the DB-level LIMIT is
  // applied to the subselect of distinct timestamps, not to the
  // flattened row count. Using a correlated subquery keeps the ordering
  // cheap and deterministic for Neon's planner.
  const selectSql = `
    SELECT
      timestamp, strike, price,
      call_gamma_oi, put_gamma_oi,
      call_gamma_vol, put_gamma_vol,
      call_gamma_ask, call_gamma_bid,
      put_gamma_ask, put_gamma_bid,
      call_charm_oi, put_charm_oi,
      call_charm_vol, put_charm_vol,
      call_delta_oi, put_delta_oi,
      call_vanna_oi, put_vanna_oi,
      call_vanna_vol, put_vanna_vol
    FROM gex_strike_0dte
    WHERE date = $1
      AND timestamp IN (
        SELECT DISTINCT timestamp
        FROM gex_strike_0dte
        WHERE date = $1 AND timestamp <= $2
        ORDER BY timestamp DESC
        LIMIT $3
      )
    ORDER BY timestamp ASC, strike ASC
  `;

  let rows: RawStrikeRow[];
  try {
    rows = (await sql.query(selectSql, [
      date,
      asOfTimestamp,
      historySize,
    ])) as RawStrikeRow[];
  } catch (err) {
    logger.warn(
      { err, date, asOfTimestamp },
      'loadSnapshotHistory: gex_strike_0dte query failed',
    );
    return [];
  }

  if (rows.length === 0) return [];

  return groupRowsIntoSnapshots(rows);
}

/**
 * Group flat per-strike rows into `GexSnapshot` objects keyed by
 * timestamp. Timestamps with malformed data (non-finite price, missing
 * strike list) are logged and dropped.
 */
function groupRowsIntoSnapshots(rows: RawStrikeRow[]): GexSnapshot[] {
  const byTs = new Map<string, { price: number; strikes: GexStrikeRow[] }>();

  for (const row of rows) {
    const ts =
      row.timestamp instanceof Date
        ? row.timestamp.toISOString()
        : new Date(row.timestamp).toISOString();

    const price = Number.parseFloat(row.price);
    if (!Number.isFinite(price)) {
      continue;
    }

    const strike = Number.parseFloat(row.strike);
    if (!Number.isFinite(strike)) {
      continue;
    }

    let bucket = byTs.get(ts);
    if (!bucket) {
      bucket = { price, strikes: [] };
      byTs.set(ts, bucket);
    }

    bucket.strikes.push({
      strike,
      price,
      callGammaOi: toNum(row.call_gamma_oi),
      putGammaOi: toNum(row.put_gamma_oi),
      callGammaVol: toNum(row.call_gamma_vol),
      putGammaVol: toNum(row.put_gamma_vol),
      callGammaAsk: toNum(row.call_gamma_ask),
      callGammaBid: toNum(row.call_gamma_bid),
      putGammaAsk: toNum(row.put_gamma_ask),
      putGammaBid: toNum(row.put_gamma_bid),
      callCharmOi: toNum(row.call_charm_oi),
      putCharmOi: toNum(row.put_charm_oi),
      callCharmVol: toNum(row.call_charm_vol),
      putCharmVol: toNum(row.put_charm_vol),
      callDeltaOi: toNum(row.call_delta_oi),
      putDeltaOi: toNum(row.put_delta_oi),
      callVannaOi: toNum(row.call_vanna_oi),
      putVannaOi: toNum(row.put_vanna_oi),
      callVannaVol: toNum(row.call_vanna_vol),
      putVannaVol: toNum(row.put_vanna_vol),
    });
  }

  const snapshots: GexSnapshot[] = [];
  for (const [ts, bucket] of byTs) {
    if (bucket.strikes.length === 0) {
      logger.warn({ timestamp: ts }, 'loadSnapshotHistory: empty strike list');
      continue;
    }
    snapshots.push({
      timestamp: ts,
      price: bucket.price,
      strikes: bucket.strikes,
    });
  }

  snapshots.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return snapshots;
}

/**
 * Parse a Neon numeric string into a JS number, defaulting to 0 on null
 * or non-finite input. Used for the optional Greek columns which may be
 * null in the DB but are expected to be numeric at the scoring layer.
 */
function toNum(value: string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

// ── writeFeatureRows ────────────────────────────────────────────────────

/**
 * Compute scoring for every mode via `computeGexTarget` and flatten the
 * resulting leaderboards into `gex_target_features` rows. Writes up to
 * 30 rows per call (10 strikes × 3 modes) with a single multi-row
 * INSERT that uses `ON CONFLICT DO NOTHING` for idempotence.
 *
 * Returns zeros (without touching the DB) when:
 *  - the input snapshot history is too short (< 2 snapshots)
 *  - `computeGexTarget` returns empty leaderboards for every mode
 *  - the SQL insert throws (logged as a warning, never re-raised)
 *
 * The `skipped` counter reflects rows that collided with the unique
 * constraint — this is expected and normal under backfill re-runs.
 */
export async function writeFeatureRows(
  snapshots: GexSnapshot[],
  date: string,
  timestamp: string,
): Promise<WriteFeatureRowsResult> {
  const empty: WriteFeatureRowsResult = {
    written: 0,
    skipped: 0,
    modes: {
      oi: { written: 0, skipped: 0 },
      vol: { written: 0, skipped: 0 },
      dir: { written: 0, skipped: 0 },
    },
  };

  if (snapshots.length < 2) {
    return empty;
  }

  let scored: {
    oi: TargetScore;
    vol: TargetScore;
    dir: TargetScore;
  };
  try {
    scored = computeGexTarget(snapshots);
  } catch (err) {
    logger.warn({ err }, 'writeFeatureRows: computeGexTarget threw');
    return empty;
  }

  // Accumulate (mode, score, nearest-wall) triples so we can issue a
  // single multi-row INSERT covering all three modes at once.
  interface RowPlan {
    mode: Mode;
    score: StrikeScore;
    wall: NearestWallContext;
  }

  const plans: RowPlan[] = [];
  const modes: Mode[] = ['oi', 'vol', 'dir'];
  const attemptedByMode: Record<Mode, number> = { oi: 0, vol: 0, dir: 0 };

  for (const mode of modes) {
    const leaderboard = scored[mode].leaderboard;
    if (leaderboard.length === 0) continue;

    const wall = computeNearestWalls(leaderboard);
    for (const score of leaderboard) {
      plans.push({ mode, score, wall });
      attemptedByMode[mode] += 1;
    }
  }

  if (plans.length === 0) {
    return empty;
  }

  const sql = getDb();
  const params: unknown[] = [];
  const valuesClauses: string[] = [];

  for (const plan of plans) {
    const base = params.length;
    const placeholders: string[] = [];
    for (let i = 1; i <= COLUMNS_PER_ROW; i++) {
      placeholders.push(`$${base + i}`);
    }
    valuesClauses.push(`(${placeholders.join(',')})`);
    pushRowParams(params, date, timestamp, plan.mode, plan.score, plan.wall);
  }

  const insertSql = buildInsertSql(valuesClauses);

  let insertResult: Array<{ id: number; mode: string }>;
  try {
    insertResult = (await sql.query(insertSql, params)) as Array<{
      id: number;
      mode: string;
    }>;
  } catch (err) {
    logger.warn({ err }, 'writeFeatureRows: gex_target_features insert failed');
    return empty;
  }

  // Per-mode tally. `RETURNING mode` lets us split the written count
  // without another round-trip.
  const writtenByMode: Record<Mode, number> = { oi: 0, vol: 0, dir: 0 };
  for (const row of insertResult) {
    if (row.mode === 'oi' || row.mode === 'vol' || row.mode === 'dir') {
      writtenByMode[row.mode] += 1;
    }
  }

  const result: WriteFeatureRowsResult = {
    written: insertResult.length,
    skipped: plans.length - insertResult.length,
    modes: {
      oi: {
        written: writtenByMode.oi,
        skipped: attemptedByMode.oi - writtenByMode.oi,
      },
      vol: {
        written: writtenByMode.vol,
        skipped: attemptedByMode.vol - writtenByMode.vol,
      },
      dir: {
        written: writtenByMode.dir,
        skipped: attemptedByMode.dir - writtenByMode.dir,
      },
    },
  };

  return result;
}

/**
 * Compute the four board-level nearest-wall values for one mode's
 * universe. A "wall" is a strike with non-zero `gexDollars` — positive
 * gamma above spot is a call wall, negative gamma below spot is a put
 * wall. For each side we find the strike closest to spot (by `|dist|`)
 * and return its distance and the magnitude (`|gexDollars|`).
 *
 * Returns null for a side when no wall exists in that direction, which
 * is common during quiet sessions or when the universe is one-sided.
 * The values are board-level, so every row in the same (snapshot, mode)
 * tuple gets the same four values.
 */
function computeNearestWalls(
  leaderboard: readonly StrikeScore[],
): NearestWallContext {
  let posDist: number | null = null;
  let posGex: number | null = null;
  let negDist: number | null = null;
  let negGex: number | null = null;

  for (const entry of leaderboard) {
    const { strike, spot, gexDollars } = entry.features;
    if (gexDollars > 0 && strike > spot) {
      const dist = strike - spot;
      if (posDist === null || dist < posDist) {
        posDist = dist;
        posGex = Math.abs(gexDollars);
      }
    } else if (gexDollars < 0 && strike < spot) {
      const dist = spot - strike;
      if (negDist === null || dist < negDist) {
        negDist = dist;
        negGex = Math.abs(gexDollars);
      }
    }
  }

  return { posDist, posGex, negDist, negGex };
}

/**
 * Push the 39 column values for a single feature row onto the shared
 * params array. Column order must match `buildInsertSql` exactly.
 */
function pushRowParams(
  params: unknown[],
  date: string,
  timestamp: string,
  mode: Mode,
  score: StrikeScore,
  wall: NearestWallContext,
): void {
  const { features, components } = score;
  params.push(
    // Identity
    date,
    timestamp,
    mode,
    GEX_TARGET_CONFIG.mathVersion,
    features.strike,
    // Ranking
    score.rankByScore,
    score.rankBySize,
    score.isTarget,
    // Layer 2 — core feature
    features.gexDollars,
    // Layer 2 — delta horizons
    features.deltaGex_1m,
    features.deltaGex_5m,
    features.deltaGex_20m,
    features.deltaGex_60m,
    features.prevGexDollars_1m,
    features.prevGexDollars_5m,
    features.prevGexDollars_20m,
    features.prevGexDollars_60m,
    features.deltaPct_1m,
    features.deltaPct_5m,
    features.deltaPct_20m,
    features.deltaPct_60m,
    // Layer 2 — other features
    features.callRatio,
    features.charmNet,
    features.deltaNet,
    features.vannaNet,
    features.distFromSpot,
    features.spot,
    features.minutesAfterNoonCT,
    // Layer 2 — board-level wall metadata
    wall.posDist,
    wall.posGex,
    wall.negDist,
    wall.negGex,
    // Layer 3 — component scores
    components.flowConfluence,
    components.priceConfirm,
    components.charmScore,
    components.dominance,
    components.clarity,
    components.proximity,
    // Layer 3 — composite outputs
    score.finalScore,
    score.tier,
    score.wallSide,
  );
}

/**
 * Build the full multi-row INSERT statement. Column order is pinned
 * here — the params pushed by `pushRowParams` MUST match 1:1.
 */
function buildInsertSql(valuesClauses: string[]): string {
  return `
    INSERT INTO gex_target_features (
      date, timestamp, mode, math_version, strike,
      rank_in_mode, rank_by_size, is_target,
      gex_dollars,
      delta_gex_1m, delta_gex_5m, delta_gex_20m, delta_gex_60m,
      prev_gex_dollars_1m, prev_gex_dollars_5m,
      prev_gex_dollars_20m, prev_gex_dollars_60m,
      delta_pct_1m, delta_pct_5m, delta_pct_20m, delta_pct_60m,
      call_ratio, charm_net, delta_net, vanna_net,
      dist_from_spot, spot_price, minutes_after_noon_ct,
      nearest_pos_wall_dist, nearest_pos_wall_gex,
      nearest_neg_wall_dist, nearest_neg_wall_gex,
      flow_confluence, price_confirm, charm_score,
      dominance, clarity, proximity,
      final_score, tier, wall_side
    )
    VALUES ${valuesClauses.join(',')}
    ON CONFLICT (date, timestamp, mode, strike, math_version) DO NOTHING
    RETURNING id, mode
  `;
}
