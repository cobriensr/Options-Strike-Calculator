/**
 * GET /api/gex-target-history
 *
 * Returns the GexTarget payload for one snapshot of `gex_target_features`,
 * plus the per-day SPX 1-minute candles needed by the price-chart panel.
 *
 * The endpoint supports three input modes — chosen implicitly via query
 * params so the frontend hook (`useGexTarget`) and the historical scrubber
 * share the same code path:
 *
 *   1. **Live**           — `GET /api/gex-target-history` with no params.
 *      Returns the latest snapshot of the most recent date that has any
 *      rows in `gex_target_features`. NOT today, because at session start
 *      today may have zero rows yet.
 *
 *   2. **Live for date**  — `?date=YYYY-MM-DD`. Returns the latest
 *      snapshot of the requested trading date (ET).
 *
 *   3. **Scrubbed**       — `?date=YYYY-MM-DD&ts=<ISO>`. Returns the
 *      exact `(date, ts)` snapshot. If `ts` is missing or doesn't exist
 *      in the snapshot list for the requested date, falls back silently
 *      to the latest snapshot for that date.
 *
 * `availableDates` is ALWAYS populated on every request — it is the
 * data-availability check from Appendix E #8 of the GexTarget rebuild
 * plan. The frontend uses this to render the historical UX (date picker
 * gating, "no data yet" placeholders, etc.) without a separate round-trip.
 *
 * Owner-or-guest — Greek exposure derives from UW API (OPRA compliance).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from './_lib/db.js';
import { Sentry, metrics } from './_lib/sentry.js';
import { guardOwnerOrGuestEndpoint } from './_lib/api-helpers.js';
import logger from './_lib/logger.js';
import { fetchSPXCandles, type SPXCandle } from './_lib/spx-candles.js';
import type {
  StrikeScore,
  TargetScore,
  Tier,
  WallSide,
  Mode,
} from '../src/utils/gex-target/index.js';

// ── Response shape ─────────────────────────────────────────────

/**
 * One snapshot's worth of scored targets in the bulk response.
 *
 * Returned as an element of `GexTargetBulkResponse.snapshots` when the
 * caller passes `?all=true`. Each entry corresponds to one timestamp
 * recorded for the resolved date.
 */
export interface BulkSnapshot {
  timestamp: string;
  spot: number | null;
  oi: TargetScore | null;
  vol: TargetScore | null;
  dir: TargetScore | null;
}

/**
 * Response shape for the `?all=true` bulk mode of
 * `GET /api/gex-target-history`.
 *
 * Unlike the single-snapshot response, the top level does NOT contain
 * `timestamp`, `spot`, `oi`, `vol`, or `dir` — those are inside each
 * element of `snapshots` instead.
 */
interface GexTargetBulkResponse {
  availableDates: string[];
  date: string;
  timestamps: string[];
  candles: SPXCandle[];
  previousClose: number | null;
  snapshots: BulkSnapshot[];
}

/**
 * Payload returned by `GET /api/gex-target-history`.
 *
 * Every field except `availableDates` may be empty/null when the
 * requested date has no rows in `gex_target_features`. `availableDates`
 * is always populated so the frontend can render the historical UX
 * without a separate round-trip.
 */
export interface GexTargetHistoryResponse {
  /**
   * Every distinct trading date currently present in
   * `gex_target_features`, sorted ascending. Used by the frontend to
   * gate the date picker, render "no data" placeholders, and decide
   * whether to fall back to a different date.
   */
  availableDates: string[];

  /**
   * The trading date the response is for (YYYY-MM-DD, ET). Null only
   * when `availableDates` is empty.
   */
  date: string | null;

  /**
   * Every snapshot timestamp recorded for `date`, sorted ascending
   * (ISO 8601 UTC). Empty array when the date has no data yet.
   */
  timestamps: string[];

  /**
   * The snapshot the response is for. Defaults to the last entry of
   * `timestamps` (latest snapshot of the day). Null when no data.
   */
  timestamp: string | null;

  /** Spot price at the returned snapshot. Null when no data. */
  spot: number | null;

  /** OI-mode TargetScore for the returned snapshot. Null when no data. */
  oi: TargetScore | null;

  /** VOL-mode TargetScore for the returned snapshot. Null when no data. */
  vol: TargetScore | null;

  /** DIR-mode TargetScore for the returned snapshot. Null when no data. */
  dir: TargetScore | null;

  /**
   * Regular-session SPX 1-minute candles for `date`, ascending. Empty
   * array if `fetchSPXCandles` returns nothing or throws (the endpoint
   * never fails the whole request just because the price chart data is
   * unavailable).
   */
  candles: SPXCandle[];

  /** Previous session close (SPX), or null if not available. */
  previousClose: number | null;
}

// ── Row shape from gex_target_features ────────────────────────

/**
 * Numeric column as returned by the Neon driver — NUMERIC arrives as a
 * string to preserve precision, but tests / older driver paths can also
 * surface a JS number, so we accept either.
 */
type Numeric = string | number;

/** Same as `Numeric`, but explicitly nullable for nullable columns. */
type NumericOrNull = Numeric | null;

/**
 * Raw row shape returned by `SELECT * FROM gex_target_features`. Numeric
 * columns arrive as strings from the Neon serverless driver — every
 * read is funneled through `Number(...)` in `rowToStrikeScore` so the
 * `StrikeScore` type contract is preserved.
 *
 * The four `nearest_*_wall_*` columns exist on the row but are
 * intentionally NOT mapped into `StrikeScore` — they're stored for the
 * Appendix B futures-validation experiments and aren't part of the
 * Phase 1 `MagnetFeatures` contract.
 */
interface GexTargetFeatureRow {
  date: string | Date;
  timestamp: string | Date;
  mode: string;
  math_version: string;
  strike: Numeric;

  /** Raw net GEX from the JOIN — replaces the stale stored value. */
  gex_dollars: Numeric;
  /** Call-side GEX from the JOIN (display only). */
  call_gex_dollars: Numeric;
  /** Put-side GEX from the JOIN (display only). */
  put_gex_dollars: Numeric;
  /** Call delta exposure from greek_exposure_strike JOIN (display only). */
  call_delta: NumericOrNull;
  /** Put delta exposure from greek_exposure_strike JOIN (display only). */
  put_delta: NumericOrNull;

  delta_gex_1m: NumericOrNull;
  delta_gex_5m: NumericOrNull;
  delta_gex_20m: NumericOrNull;
  delta_gex_60m: NumericOrNull;

  prev_gex_dollars_1m: NumericOrNull;
  prev_gex_dollars_5m: NumericOrNull;
  prev_gex_dollars_10m: NumericOrNull;
  prev_gex_dollars_15m: NumericOrNull;
  prev_gex_dollars_20m: NumericOrNull;
  prev_gex_dollars_60m: NumericOrNull;

  delta_pct_1m: NumericOrNull;
  delta_pct_5m: NumericOrNull;
  delta_pct_20m: NumericOrNull;
  delta_pct_60m: NumericOrNull;

  call_ratio: Numeric;
  charm_net: Numeric;
  delta_net: Numeric;
  vanna_net: Numeric;
  dist_from_spot: Numeric;
  spot_price: Numeric;
  minutes_after_noon_ct: Numeric;
}

// ── Helpers ────────────────────────────────────────────────────

/**
 * Normalize a Postgres TIMESTAMPTZ / DATE value to its canonical string.
 *
 * The Neon serverless driver returns these columns as JavaScript Date
 * objects when using the SQL template tag and as strings via the older
 * `query()` path. The two forms must serialize identically across the
 * response so the frontend can compare `timestamp` against entries in
 * `timestamps[]` for scrub navigation.
 */
function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const str = String(value);
  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime()) ? str : parsed.toISOString();
}

/**
 * Normalize a Postgres DATE value to a YYYY-MM-DD string.
 *
 * The Neon driver returns DATE columns as JavaScript Date objects (in
 * UTC midnight). `toISOString().slice(0, 10)` gives back the same
 * YYYY-MM-DD that was originally inserted.
 */
function toDateString(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const str = String(value);
  // If the driver already gave us "YYYY-MM-DD" or a longer ISO string,
  // slicing is safe and avoids a Date round-trip that could shift the
  // day across timezones.
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime())
    ? null
    : parsed.toISOString().slice(0, 10);
}

/**
 * Coerce a numeric DB column to a JS number. The Neon driver returns
 * NUMERIC columns as strings to preserve precision; the StrikeScore
 * contract expects numbers, so every numeric column goes through this.
 */
function num(value: Numeric): number {
  return typeof value === 'number' ? value : Number(value);
}

/**
 * Same as `num`, but preserves null. Used for the per-horizon delta /
 * prev / pct columns which are explicitly nullable in the schema.
 */
function numOrNull(value: NumericOrNull): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : Number(value);
}

/**
 * Reconstruct a `StrikeScore` from one `gex_target_features` row.
 *
 * This is the inverse of `pushRowParams` in `api/_lib/gex-target-features.ts`.
 * The two functions must stay in sync. The Phase 1.5 awareness here is
 * that `MagnetFeatures` does NOT have a singular `prevGexDollars` field
 * anymore — only the four per-horizon variants. Don't accidentally
 * reintroduce the old field name.
 *
 * Derived scoring fields (ranking, components, finalScore, tier, wallSide)
 * were dropped from the DB in migration #58. The `StrikeScore` type still
 * requires them, so we fill them with sentinel defaults — the browser
 * recomputes every derived field from the raw features before display.
 */
function rowToStrikeScore(row: GexTargetFeatureRow): StrikeScore {
  const strike = num(row.strike);
  return {
    strike,
    features: {
      strike,
      spot: num(row.spot_price),
      distFromSpot: num(row.dist_from_spot),
      gexDollars: num(row.gex_dollars),
      callGexDollars: num(row.call_gex_dollars),
      putGexDollars: num(row.put_gex_dollars),
      callDelta: numOrNull(row.call_delta),
      putDelta: numOrNull(row.put_delta),
      deltaGex_1m: numOrNull(row.delta_gex_1m),
      deltaGex_5m: numOrNull(row.delta_gex_5m),
      deltaGex_20m: numOrNull(row.delta_gex_20m),
      deltaGex_60m: numOrNull(row.delta_gex_60m),
      prevGexDollars_1m: numOrNull(row.prev_gex_dollars_1m),
      prevGexDollars_5m: numOrNull(row.prev_gex_dollars_5m),
      prevGexDollars_10m: numOrNull(row.prev_gex_dollars_10m),
      prevGexDollars_15m: numOrNull(row.prev_gex_dollars_15m),
      prevGexDollars_20m: numOrNull(row.prev_gex_dollars_20m),
      prevGexDollars_60m: numOrNull(row.prev_gex_dollars_60m),
      deltaPct_1m: numOrNull(row.delta_pct_1m),
      deltaPct_5m: numOrNull(row.delta_pct_5m),
      deltaPct_20m: numOrNull(row.delta_pct_20m),
      deltaPct_60m: numOrNull(row.delta_pct_60m),
      callRatio: num(row.call_ratio),
      charmNet: num(row.charm_net),
      deltaNet: num(row.delta_net),
      vannaNet: num(row.vanna_net),
      minutesAfterNoonCT: num(row.minutes_after_noon_ct),
    },
    components: {
      flowConfluence: 0,
      priceConfirm: 0,
      charmScore: 0,
      dominance: 0,
      clarity: 0,
      proximity: 0,
    },
    finalScore: 0,
    tier: 'NONE' as Tier,
    wallSide: 'NEUTRAL' as WallSide,
    rankByScore: 0,
    rankBySize: 0,
    isTarget: false,
  };
}

/**
 * Group rows for one snapshot into the three per-mode `TargetScore`
 * objects the frontend consumes. Returns null for any mode that has no
 * rows in the snapshot.
 *
 * Migration #58 dropped the `rank_in_mode` and `is_target` columns, so
 * leaderboard ordering is no longer stored. We sort by `|gex_dollars|`
 * descending as a deterministic ordering fallback — the browser
 * recomputes its own ranking before display so the exact order here
 * doesn't affect the UI, it just needs to be stable.
 *
 * `target` is always null from the server: the browser computes the
 * target itself from the raw features in each `StrikeScore`.
 */
function groupRowsByMode(rows: GexTargetFeatureRow[]): {
  oi: TargetScore | null;
  vol: TargetScore | null;
  dir: TargetScore | null;
} {
  const buckets: Record<Mode, GexTargetFeatureRow[]> = {
    oi: [],
    vol: [],
    dir: [],
  };

  for (const row of rows) {
    if (row.mode === 'oi' || row.mode === 'vol' || row.mode === 'dir') {
      buckets[row.mode].push(row);
    }
  }

  const buildScore = (modeRows: GexTargetFeatureRow[]): TargetScore | null => {
    if (modeRows.length === 0) return null;
    // Deterministic fallback ordering — by |gex_dollars| desc. The
    // browser re-ranks before display, so this only needs to be stable.
    const sorted = [...modeRows].sort(
      (a, b) => Math.abs(num(b.gex_dollars)) - Math.abs(num(a.gex_dollars)),
    );
    const leaderboard = sorted.map(rowToStrikeScore);
    return { target: null, leaderboard };
  };

  return {
    oi: buildScore(buckets.oi),
    vol: buildScore(buckets.vol),
    dir: buildScore(buckets.dir),
  };
}

/**
 * Best-effort SPX candle fetch. Wrapping the call in its own try/catch
 * means the price chart panel can be empty without taking down the
 * entire endpoint — the leaderboard / target / scoring data is still
 * useful even when UW is down or the candles cron has missed a date.
 */
async function safeFetchCandles(
  date: string,
): Promise<{ candles: SPXCandle[]; previousClose: number | null }> {
  const apiKey = process.env.UW_API_KEY ?? '';
  try {
    return await fetchSPXCandles(apiKey, date);
  } catch (err) {
    logger.warn(
      { err, date },
      'gex-target-history: fetchSPXCandles failed; returning empty candles',
    );
    return { candles: [], previousClose: null };
  }
}

// ── Handler ────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/gex-target-history');
    const done = metrics.request('/api/gex-target-history');

    if (req.method !== 'GET') {
      done({ status: 405 });
      return res.status(405).json({ error: 'GET only' });
    }

    if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

    // Validate the optional `date` param up front. An obviously
    // malformed value is a 400 — silently swapping in today would
    // mask client-side bugs and is harder to debug.
    const dateParam = req.query.date as string | undefined;
    if (dateParam !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      res.setHeader('Cache-Control', 'no-store');
      done({ status: 400 });
      return res.status(400).json({ error: 'Invalid date' });
    }

    // Validate the optional `ts` param shape. An invalid `ts` is NOT a
    // 400 — we silently fall back to the latest snapshot for the day
    // so a stale scrubber URL still produces useful data.
    const tsParam = req.query.ts as string | undefined;
    const hasTs =
      tsParam !== undefined &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(tsParam);

    try {
      const sql = getDb();

      // ── 1. availableDates: every distinct trading date with rows ──
      const datesRows = (await sql`
        SELECT DISTINCT date
        FROM gex_target_features
        ORDER BY date ASC
      `) as Array<{ date: string | Date }>;

      const availableDates = datesRows
        .map((r) => toDateString(r.date))
        .filter((d): d is string => d != null);

      // Empty database — return the empty payload shape so the frontend
      // can render its "no data yet" state without crashing.
      if (availableDates.length === 0) {
        const empty: GexTargetHistoryResponse = {
          availableDates: [],
          date: null,
          timestamps: [],
          timestamp: null,
          spot: null,
          oi: null,
          vol: null,
          dir: null,
          candles: [],
          previousClose: null,
        };
        res.setHeader('Cache-Control', 'no-store');
        done({ status: 200 });
        return res.status(200).json(empty);
      }

      // ── 2. Resolve the target date ────────────────────────────────
      // Use the requested date if provided; otherwise pick the most
      // recent available date. We deliberately do NOT clamp to today
      // because at session start today's row count may be zero.
      const date = dateParam ?? availableDates.at(-1)!;

      // ── 3. List timestamps for the resolved date ──────────────────
      const timestampRows = (await sql`
        SELECT DISTINCT timestamp
        FROM gex_target_features
        WHERE date = ${date}
        ORDER BY timestamp ASC
      `) as Array<{ timestamp: string | Date }>;

      const timestamps = timestampRows
        .map((r) => toIso(r.timestamp))
        .filter((s): s is string => s != null);

      // No rows for the resolved date (e.g., requested a date that's in
      // availableDates from a stale cache, or the date param doesn't
      // match anything). Always include candles + availableDates so the
      // frontend can keep its other panels populated.
      if (timestamps.length === 0) {
        const { candles, previousClose } = await safeFetchCandles(date);
        const empty: GexTargetHistoryResponse = {
          availableDates,
          date,
          timestamps: [],
          timestamp: null,
          spot: null,
          oi: null,
          vol: null,
          dir: null,
          candles,
          previousClose,
        };
        res.setHeader('Cache-Control', 'no-store');
        done({ status: 200 });
        return res.status(200).json(empty);
      }

      // ── 4. Resolve the target timestamp ───────────────────────────
      // If the caller passed a valid `ts` and it exists in the day's
      // snapshot list, use it. Otherwise fall back to the latest
      // snapshot. The frontend treats this fallback as the "live" path.
      let timestamp: string;
      if (hasTs && tsParam !== undefined) {
        const normalizedTs = toIso(tsParam) ?? tsParam;
        timestamp = timestamps.includes(normalizedTs)
          ? normalizedTs
          : timestamps.at(-1)!;
      } else {
        timestamp = timestamps.at(-1)!;
      }

      // ── 4b. Bulk mode (?all=true) ─────────────────────────────────
      // When the caller passes `?all=true`, return every snapshot for
      // the resolved date in one payload instead of a single-snapshot
      // response. This branch shares steps 1–4 (availableDates, date
      // resolution, timestamps, timestamp resolution) with the existing
      // path and returns early so the single-snapshot path below is
      // completely unchanged.
      if (req.query.all === 'true') {
        const allRows = (await sql`
          SELECT
            gtf.date, gtf.timestamp, gtf.mode, gtf.math_version, gtf.strike,
            CASE gtf.mode
              -- OI mode: use greek_exposure_strike × spot × 0.01 to convert raw
              -- gamma exposure (gamma × OI × 100) to dealer dollar hedging
              -- exposure per 1% SPX move — matching SOFBOT's M/K display scale.
              WHEN 'oi'  THEN COALESCE(ges.net_gex * gtf.spot_price::numeric * 0.01, gtf.gex_dollars)
              WHEN 'vol' THEN COALESCE(gso.call_gamma_vol::numeric + gso.put_gamma_vol::numeric, gtf.gex_dollars)
              WHEN 'dir' THEN COALESCE(gso.call_gamma_ask::numeric + gso.call_gamma_bid::numeric + gso.put_gamma_ask::numeric + gso.put_gamma_bid::numeric, gtf.gex_dollars)
              ELSE gtf.gex_dollars
            END AS gex_dollars,
            CASE gtf.mode
              WHEN 'oi'  THEN COALESCE(ges.call_gex::numeric * gtf.spot_price::numeric * 0.01, 0)
              WHEN 'vol' THEN COALESCE(gso.call_gamma_vol::numeric, 0)
              WHEN 'dir' THEN COALESCE(gso.call_gamma_ask::numeric + gso.call_gamma_bid::numeric, 0)
              ELSE 0
            END AS call_gex_dollars,
            CASE gtf.mode
              WHEN 'oi'  THEN COALESCE(ges.put_gex::numeric * gtf.spot_price::numeric * 0.01, 0)
              WHEN 'vol' THEN COALESCE(gso.put_gamma_vol::numeric, 0)
              WHEN 'dir' THEN COALESCE(gso.put_gamma_ask::numeric + gso.put_gamma_bid::numeric, 0)
              ELSE 0
            END AS put_gex_dollars,
            ges.call_delta,
            ges.put_delta,
            gtf.delta_gex_1m, gtf.delta_gex_5m, gtf.delta_gex_20m, gtf.delta_gex_60m,
            gtf.prev_gex_dollars_1m, gtf.prev_gex_dollars_5m,
            gtf.prev_gex_dollars_10m, gtf.prev_gex_dollars_15m,
            gtf.prev_gex_dollars_20m, gtf.prev_gex_dollars_60m,
            gtf.delta_pct_1m, gtf.delta_pct_5m, gtf.delta_pct_20m, gtf.delta_pct_60m,
            gtf.call_ratio, gtf.charm_net, gtf.delta_net, gtf.vanna_net,
            gtf.dist_from_spot, gtf.spot_price, gtf.minutes_after_noon_ct
          FROM gex_target_features gtf
          LEFT JOIN gex_strike_0dte gso
            ON  gso.date      = gtf.date
            AND gso.timestamp = gtf.timestamp
            AND gso.strike::numeric = gtf.strike::numeric
          LEFT JOIN greek_exposure_strike ges
            ON  ges.date   = gtf.date
            AND ges.expiry = gtf.date
            AND ges.strike::numeric = gtf.strike::numeric
          WHERE gtf.date = ${date}
          ORDER BY gtf.timestamp ASC, gtf.mode ASC, gtf.strike ASC
        `) as GexTargetFeatureRow[];

        // Group rows by their normalized timestamp key.
        const byTimestamp = new Map<string, GexTargetFeatureRow[]>();
        for (const row of allRows) {
          const key = toIso(row.timestamp) ?? String(row.timestamp);
          const bucket = byTimestamp.get(key);
          if (bucket) {
            bucket.push(row);
          } else {
            byTimestamp.set(key, [row]);
          }
        }

        // Build one BulkSnapshot per timestamp in ascending order.
        const snapshots: BulkSnapshot[] = timestamps
          .filter((ts) => byTimestamp.has(ts))
          .map((ts) => {
            const rows = byTimestamp.get(ts)!;
            const grouped = groupRowsByMode(rows);
            const spot = rows.length > 0 ? num(rows[0]!.spot_price) : null;
            return { timestamp: ts, spot, ...grouped };
          });

        const { candles, previousClose } = await safeFetchCandles(date);

        const bulkResponse: GexTargetBulkResponse = {
          availableDates,
          date,
          timestamps,
          candles,
          previousClose,
          snapshots,
        };

        res.setHeader('Cache-Control', 'no-store');
        done({ status: 200 });
        return res.status(200).json(bulkResponse);
      }

      // ── 5. Fetch the 30 feature rows for this snapshot ────────────
      const featureRows = (await sql`
        SELECT
          gtf.date, gtf.timestamp, gtf.mode, gtf.math_version, gtf.strike,
          CASE gtf.mode
            -- OI mode: use greek_exposure_strike × spot × 0.01 to convert raw
            -- gamma exposure (gamma × OI × 100) to dealer dollar hedging
            -- exposure per 1% SPX move — matching SOFBOT's M/K display scale.
            WHEN 'oi'  THEN COALESCE(ges.net_gex * gtf.spot_price::numeric * 0.01, gtf.gex_dollars)
            WHEN 'vol' THEN COALESCE(gso.call_gamma_vol::numeric + gso.put_gamma_vol::numeric, gtf.gex_dollars)
            WHEN 'dir' THEN COALESCE(gso.call_gamma_ask::numeric + gso.call_gamma_bid::numeric + gso.put_gamma_ask::numeric + gso.put_gamma_bid::numeric, gtf.gex_dollars)
            ELSE gtf.gex_dollars
          END AS gex_dollars,
          CASE gtf.mode
            WHEN 'oi'  THEN COALESCE(ges.call_gex::numeric * gtf.spot_price::numeric * 0.01, 0)
            WHEN 'vol' THEN COALESCE(gso.call_gamma_vol::numeric, 0)
            WHEN 'dir' THEN COALESCE(gso.call_gamma_ask::numeric + gso.call_gamma_bid::numeric, 0)
            ELSE 0
          END AS call_gex_dollars,
          CASE gtf.mode
            WHEN 'oi'  THEN COALESCE(ges.put_gex::numeric * gtf.spot_price::numeric * 0.01, 0)
            WHEN 'vol' THEN COALESCE(gso.put_gamma_vol::numeric, 0)
            WHEN 'dir' THEN COALESCE(gso.put_gamma_ask::numeric + gso.put_gamma_bid::numeric, 0)
            ELSE 0
          END AS put_gex_dollars,
          ges.call_delta,
          ges.put_delta,
          gtf.delta_gex_1m, gtf.delta_gex_5m, gtf.delta_gex_20m, gtf.delta_gex_60m,
          gtf.prev_gex_dollars_1m, gtf.prev_gex_dollars_5m,
          gtf.prev_gex_dollars_10m, gtf.prev_gex_dollars_15m,
          gtf.prev_gex_dollars_20m, gtf.prev_gex_dollars_60m,
          gtf.delta_pct_1m, gtf.delta_pct_5m, gtf.delta_pct_20m, gtf.delta_pct_60m,
          gtf.call_ratio, gtf.charm_net, gtf.delta_net, gtf.vanna_net,
          gtf.dist_from_spot, gtf.spot_price, gtf.minutes_after_noon_ct
        FROM gex_target_features gtf
        LEFT JOIN gex_strike_0dte gso
          ON  gso.date      = gtf.date
          AND gso.timestamp = gtf.timestamp
          AND gso.strike::numeric = gtf.strike::numeric
        LEFT JOIN greek_exposure_strike ges
          ON  ges.date   = gtf.date
          AND ges.expiry = gtf.date
          AND ges.strike::numeric = gtf.strike::numeric
        WHERE gtf.date = ${date} AND gtf.timestamp = ${timestamp}
        ORDER BY gtf.mode ASC, gtf.strike ASC
      `) as GexTargetFeatureRow[];

      // ── 6. Reconstruct the three per-mode TargetScore objects ─────
      const grouped = groupRowsByMode(featureRows);

      // Spot is the same for every row in a snapshot — read it from any
      // row. Null only when the snapshot has zero rows (race condition
      // between the timestamp listing and the SELECT *).
      const spot =
        featureRows.length > 0 ? num(featureRows[0]!.spot_price) : null;

      // ── 7. Fetch SPX candles (best-effort) ────────────────────────
      const { candles, previousClose } = await safeFetchCandles(date);

      // ── 8. Respond ───────────────────────────────────────────────
      const response: GexTargetHistoryResponse = {
        availableDates,
        date,
        timestamps,
        timestamp,
        spot,
        oi: grouped.oi,
        vol: grouped.vol,
        dir: grouped.dir,
        candles,
        previousClose,
      };

      res.setHeader('Cache-Control', 'no-store');
      done({ status: 200 });
      return res.status(200).json(response);
    } catch (err) {
      done({ status: 500 });
      Sentry.captureException(err);
      logger.error({ err }, 'gex-target-history fetch error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
