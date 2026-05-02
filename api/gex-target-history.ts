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

import { getDb } from './_lib/db.js';
import { Sentry } from './_lib/sentry.js';
import { guardOwnerOrGuestEndpoint } from './_lib/api-helpers.js';
import { withRequestScope } from './_lib/request-scope.js';
import logger from './_lib/logger.js';
import { fetchSPXCandles, type SPXCandle } from './_lib/spx-candles.js';
import {
  loadStrikeScoreHistory,
  groupRowsByMode,
  toIso,
  toDateString,
  num,
} from './_lib/gex-target-features.js';
import type { GexTargetFeatureRow } from './_lib/gex-target-features.js';
import type { TargetScore } from '../src/utils/gex-target/index.js';

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

// ── Helpers ────────────────────────────────────────────────────

// `GexTargetFeatureRow`, `toIso`, `toDateString`, `num`, `rowToStrikeScore`,
// and `groupRowsByMode` now live in `_lib/gex-target-features.ts`. The
// rest of this module imports them — see the top-level `import { ... }`
// block above. The duplicated SELECT they backed is also extracted to
// `loadStrikeScoreHistory()` in the same module.

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

export default withRequestScope(
  'GET',
  '/api/gex-target-history',
  async (req, res, done) => {
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
        const allRows = await loadStrikeScoreHistory({ sql, date });

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
      const featureRows = await loadStrikeScoreHistory({
        sql,
        date,
        timestamp,
      });

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
  },
);
