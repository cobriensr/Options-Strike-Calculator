/**
 * Path-shape suppressor — computes freshness + progress-toward-strike on
 * IV anomaly and gamma squeeze read responses.
 *
 * Why: 2026-04-29 outlier study found that fast-ITM wins keep gains 91% of
 * the time at close, while slow-ITM wins (>30 min from print without strong
 * progress) round-trip 56% of the time. Surfacing freshness + progress lets
 * the UI visually de-emphasize alerts that haven't moved toward target —
 * users still see them but know the win-keep odds have collapsed.
 *
 * Pure functions live here. Caller (read endpoint) handles DB queries.
 *
 * See: ml/findings/outlier-detection-2026-04-28.md (Path-shape splits).
 */

import { getDb } from './db.js';

/**
 * Default thresholds — staleness requires BOTH conditions:
 *   1. freshness > 30 minutes since detection, AND
 *   2. progress toward strike is below the meaningful-move bar (25%).
 *
 * 30 minutes matches the win-keep cliff observed in the path-shape data:
 * wins that ITM within 30 min keep gains ~91% at close; wins that drag
 * past 30 min keep gains ~44%. 25% progress is the minimum move that
 * separates "moving toward target" from "noise drift."
 */
export const STALE_FRESHNESS_MIN = 30;
export const STALE_PROGRESS_PCT = 0.25;

export interface PathShape {
  /** Minutes since the alert was detected, computed against `now`. */
  freshnessMin: number;
  /**
   * Signed progress from spot_at_detect to strike, in the trade's direction.
   * 0 = no movement, 1 = reached strike, >1 = past strike, <0 = moving away.
   * Null when strike == spot_at_detect (avoids div by zero on weird ATM
   * detections).
   */
  progressPct: number | null;
  /**
   * True when the alert is older than STALE_FRESHNESS_MIN AND has not made
   * meaningful progress (|progressPct| < STALE_PROGRESS_PCT). Null progress
   * cannot be evaluated → never stale.
   */
  isStale: boolean;
}

/**
 * Compute the path-shape diagnostic for one alert.
 *
 *   `(currentSpot - spotAtDetect) / (strike - spotAtDetect)`
 *
 * Works for both calls (strike > spot, want price up) and puts
 * (strike < spot, want price down). For a put, both numerator and
 * denominator flip sign together when the underlying drops, so
 * progress comes out positive when moving toward the strike.
 */
export function computePathShape(
  alertTsMs: number,
  spotAtDetect: number,
  strike: number,
  currentSpot: number | null,
  nowMs: number,
): PathShape {
  const freshnessMin = Math.max(0, (nowMs - alertTsMs) / 60_000);

  if (currentSpot == null || !Number.isFinite(currentSpot)) {
    return { freshnessMin, progressPct: null, isStale: false };
  }

  const distanceAtDetect = strike - spotAtDetect;
  if (distanceAtDetect === 0 || !Number.isFinite(distanceAtDetect)) {
    return { freshnessMin, progressPct: null, isStale: false };
  }

  const progressPct = (currentSpot - spotAtDetect) / distanceAtDetect;

  const isStale =
    freshnessMin > STALE_FRESHNESS_MIN &&
    Math.abs(progressPct) < STALE_PROGRESS_PCT;

  return { freshnessMin, progressPct, isStale };
}

/**
 * Look up the most recent `spot` per ticker from `strike_iv_snapshots`.
 *
 * In replay mode (`at` provided), returns the spot at-or-before `at` for
 * each ticker. In live mode (`at` null), returns the latest spot.
 *
 * Returns a Map keyed on ticker. Tickers with no snapshots get omitted
 * from the map (caller treats absence as "current spot unknown").
 */
export async function getLatestSpotsByTicker(
  tickers: readonly string[],
  at: Date | null,
): Promise<Map<string, number>> {
  if (tickers.length === 0) return new Map();
  const sql = getDb();

  // Single-query lateral join — one row per ticker with its latest spot.
  // `unnest` + `LATERAL` lets us avoid N round-trips while keeping the
  // index lookup on (ticker, ts DESC) per ticker. Pass the ticker array
  // explicitly so Neon's parameterized binding sends a text[] correctly.
  const tickerArr = tickers as readonly string[];
  const rows = at
    ? ((await sql`
        SELECT t.ticker, s.spot
        FROM unnest(${tickerArr as string[]}::text[]) AS t(ticker)
        CROSS JOIN LATERAL (
          SELECT spot FROM strike_iv_snapshots
          WHERE ticker = t.ticker AND ts <= ${at.toISOString()}
          ORDER BY ts DESC LIMIT 1
        ) AS s
      `) as Array<{ ticker: string; spot: string | number | null }>)
    : ((await sql`
        SELECT t.ticker, s.spot
        FROM unnest(${tickerArr as string[]}::text[]) AS t(ticker)
        CROSS JOIN LATERAL (
          SELECT spot FROM strike_iv_snapshots
          WHERE ticker = t.ticker
          ORDER BY ts DESC LIMIT 1
        ) AS s
      `) as Array<{ ticker: string; spot: string | number | null }>);

  const out = new Map<string, number>();
  for (const r of rows) {
    if (r.spot == null) continue;
    const n = typeof r.spot === 'number' ? r.spot : Number(r.spot);
    if (Number.isFinite(n)) out.set(r.ticker, n);
  }
  return out;
}
