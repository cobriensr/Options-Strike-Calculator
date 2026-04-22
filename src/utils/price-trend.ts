/**
 * Price-trend classification — shared between client and server.
 *
 * Takes a flat series of `{price, ts}` pairs inside a lookback window
 * and emits:
 *   - `direction` — 'up' | 'down' | 'flat', gated by both an absolute
 *     magnitude threshold AND a directional-consistency threshold so
 *     chop doesn't get labeled as a drift;
 *   - `changePct` / `changePts` — net move from the oldest sample to
 *     the newest;
 *   - `consistency` — fraction of non-flat step-intervals whose
 *     direction matches the dominant direction (0–1).
 *
 * The primitive is framework-agnostic: no React, no hooks, no I/O.
 * Callers that have snapshot objects of any shape map to the
 * `{price, ts}` view before calling this. The current two callers are:
 *   - `GexLandscape` (client) — maps `Snapshot[]` via `strikes[0].price`.
 *   - `monitor-regime-events` (server cron) — maps rows from
 *     `spot_exposures` directly.
 *
 * Previously lived in `src/components/GexLandscape/deltas.ts` keyed on
 * the full `Snapshot` shape. That shape required a `strikes` array that
 * the server didn't have, forcing the server path to skip the
 * drift-override entirely — see
 * `docs/superpowers/specs/futures-playbook-server-drift-override-2026-04-21.md`
 * for the parity bug this module exists to fix.
 */

/**
 * One observation of spot price at a specific instant. Ordering is by
 * `ts` (unix milliseconds) ascending when passed into `computePriceTrend`.
 * Callers are expected to pre-filter to the lookback window; the
 * primitive trusts the series and applies the window itself as a guard.
 */
export interface PricePoint {
  /** Spot price at `ts`. Non-finite values are filtered out silently. */
  price: number;
  /** Unix milliseconds. */
  ts: number;
}

/**
 * Classification result. `direction` is always one of `'up' | 'down' |
 * 'flat'`; the fraction fields are always finite (zero-valued when
 * there isn't enough data).
 */
export interface PriceTrend {
  direction: 'up' | 'down' | 'flat';
  /** % change from oldest in-window price to newest. */
  changePct: number;
  /** Absolute-points change from oldest in-window price to newest. */
  changePts: number;
  /** Fraction of non-flat intervals in the dominant direction (0–1). */
  consistency: number;
}

/** Minimum absolute SPX points of price change to qualify as "drifting". */
export const DRIFT_PTS_THRESHOLD = 3;

/** Minimum fraction of non-flat intervals in the dominant direction (0–1). */
export const DRIFT_CONSISTENCY_THRESHOLD = 0.55;

/** Minimum number of in-window samples required to emit a non-flat result. */
const MIN_SNAPSHOTS = 3;

/** Default lookback window (5 minutes in milliseconds). */
const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

/**
 * Flat-result helper — every non-trend path returns this shape.
 */
function flatResult(): PriceTrend {
  return { direction: 'flat', changePct: 0, changePts: 0, consistency: 0 };
}

/**
 * Compute a price trend over a lookback window.
 *
 * `prices` may be in any order; the function sorts by `ts` ascending
 * internally and filters out any point outside `[nowTs − windowMs, nowTs]`.
 * Non-finite prices are dropped silently — they'd otherwise poison the
 * consistency count.
 *
 * Returns `flat` when fewer than `MIN_SNAPSHOTS` in-window points remain
 * OR when the magnitude/consistency thresholds aren't met. The return
 * shape is always the same — there's no null case — so callers can
 * destructure without conditionals.
 */
export function computePriceTrend(
  prices: PricePoint[],
  nowTs: number,
  windowMs: number = DEFAULT_WINDOW_MS,
): PriceTrend {
  const minTs = nowTs - windowMs;
  const recent = prices
    .filter(
      (p) =>
        p.ts >= minTs && p.ts <= nowTs && Number.isFinite(p.price),
    )
    .sort((a, b) => a.ts - b.ts);

  if (recent.length < MIN_SNAPSHOTS) return flatResult();

  const series = recent.map((p) => p.price);
  const first = series[0]!;
  const last = series[series.length - 1]!;
  const changePts = last - first;
  const changePct = first > 0 ? (changePts / first) * 100 : 0;

  // Count directional intervals (skip flat intervals so back-to-back
  // identical ticks don't inflate the denominator).
  let ups = 0;
  let downs = 0;
  for (let i = 1; i < series.length; i++) {
    const a = series[i]!;
    const b = series[i - 1]!;
    if (a > b) ups++;
    else if (a < b) downs++;
  }
  const total = ups + downs;
  const dominant = Math.max(ups, downs);
  const consistency = total > 0 ? dominant / total : 0;

  let direction: PriceTrend['direction'] = 'flat';
  if (
    Math.abs(changePts) >= DRIFT_PTS_THRESHOLD &&
    consistency >= DRIFT_CONSISTENCY_THRESHOLD
  ) {
    direction = changePts > 0 ? 'up' : 'down';
  }

  return { direction, changePct, changePts, consistency };
}
