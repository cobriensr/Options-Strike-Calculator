/**
 * Forced-flow penalty features (meta-detectors Phase 5).
 *
 * Goal: surface 4 NUMERIC FEATURES (per spec
 * docs/superpowers/specs/meta-detectors-2026-05-16.md §Phase 5) that capture
 * common "forced flow" patterns — bilateral hedging, sector-wide gross-up,
 * calendar-driven mechanical rolls, and cross-asset stress hedging. These
 * patterns historically corrupt the takeit training signal because they look
 * loud (size, vol/oi, ask-side share) but carry no directional information.
 *
 * Design decision per spec §"Open question 3": these are FEATURES, not score
 * modifiers. The model learns interactions with `inferred_structure`,
 * `aggressive_premium_flag`, `score`, etc. — a multiplier would zero out
 * informed prints that happen to land in a forced-flow window.
 *
 * Purity: zero I/O. Every signal is either computed from the alert row
 * fire_time, or read from the `macro` context passed by the detect cron.
 * The cron is responsible for fetching VIX intraday change + sector map
 * exactly once per run and passing the same object to every per-fire call.
 *
 * Stub policy (per spec §"Stub policy"): features that depend on data NOT
 * yet on the alert row return 0 with a code comment marking the dependency.
 * The model will learn that all-zero features carry no info; they become
 * real when the dependency lands without a feature-shape change.
 */

import type {
  LotteryAlertRow,
  SilentBoomAlertRow,
} from './takeit-features.js';

/**
 * Cross-asset stress trigger: VIX intraday change in absolute VIX points.
 * Spec §"Thresholds": > +3pts → flag. Strict-greater (NOT ≥) — a clean
 * +3.00 spike is on the edge and stays in "normal regime" (matches the
 * spec wording "VIX intraday change > +3pts at alert time" and the
 * comparison at `computeCrossAssetStressFlag`).
 */
export const CROSS_ASSET_STRESS_VIX_THRESHOLD_PTS = 3;

/**
 * Cross-name cluster scoring: spec §"Thresholds" says N≥5 same-sector
 * tickers within 5 min → score in [0,1]. 5 → 0.5, 10+ → 1.0, linear.
 * Implemented as `clamp(count / 10, 0, 1)` with a hard floor at the N≥5
 * gate (returns 0 below 5 → no signal). 10 is the saturation count.
 */
export const CROSS_NAME_CLUSTER_MIN_TICKERS = 5;
export const CROSS_NAME_CLUSTER_SATURATION_TICKERS = 10;

/**
 * Quarter-end CT closing-hour window: 14:00-15:00 CT (last hour of the
 * regular cash session). Boundary convention left-inclusive of 14:00 and
 * right-exclusive of 15:00 (matches `sessionPhaseCatFromMinuteCt('closing')`).
 */
const QUARTER_END_HOUR_START_CT = 14 * 60; // 14:00 CT
const QUARTER_END_HOUR_END_CT = 15 * 60; // 15:00 CT (exclusive)

/**
 * Macro context the detect cron pre-fetches ONCE per run and passes to every
 * per-fire call. Every field is optional — missing data → that feature
 * scores 0 (genuinely "no signal available") per the stub policy.
 *
 * Forward-compat: this shape is extended (not replaced) when a future phase
 * wires the bilateral-fire window or yesterday's calendar events. Adding an
 * optional field here is non-breaking for existing callers.
 */
export interface ForcedFlowMacroContext {
  /**
   * VIX intraday change in absolute VIX points (today's last print minus
   * today's open). Positive = stress. Null when the VIX hook hasn't seeded
   * yet for the day.
   */
  vixIntradayChange?: number | null;

  /**
   * Optional sector lookup keyed by underlying ticker. Used by the
   * cross-name cluster feature when wired; absent → feature stubs to 0.
   */
  sectorMap?: ReadonlyMap<string, string> | null;
}

/**
 * Feature output shape — every value is a deterministic number so the
 * trainer can pin them directly into `feature_cols` without one-hot
 * expansion. Booleans are encoded 0/1 (NOT null) so they coexist cleanly
 * with the existing `*_flag` features.
 */
export interface ForcedFlowFeatures {
  bilateral_flow_score: number;
  cross_name_cluster_score: number;
  calendar_adjacency_flag: number;
  cross_asset_stress_flag: number;
}

// ── Bilateral flow ────────────────────────────────────────────

/**
 * `bilateral_flow_score` ∈ [0, 1] — proxy for "same ticker has BOTH calls
 * AND puts qualified in a 10-min window of THIS alert".
 *
 * STUB v1: the alert row does NOT carry recent-fire context (that lives on
 * `SequentialContext.recentSameTypeFires` /
 * `SequentialContext.recentOtherTypeByTickerDir`, which the spec's pure
 * `(alert, macro)` signature does not accept). Until the controller wires a
 * `bilateralFireCount` (or equivalent) into the alert row or the macro arg,
 * this returns 0 by design. The all-zero feature is a truthful signal —
 * "no bilateral context available at scoring time" — and the model treats
 * it as a no-op rather than a false negative.
 *
 * Dependency: when bilateral context lands on the alert row (likely as
 * `bilateral_qualifying_opposite_count` populated by detect-* crons), drop
 * the 0 stub and replace with `count > 0 ? clamp(count/N, 0, 1) : 0`.
 */
// STUB: see fn-doc. Re-wire when bilateral_qualifying_opposite_count lands
// on LotteryAlertRow / SilentBoomAlertRow. Args kept underscore-prefixed +
// suppressed for the unused-vars rule so the documented signature is
// preserved for the eventual rewire.
function computeBilateralFlowScore(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _alert: LotteryAlertRow | SilentBoomAlertRow,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _macro: ForcedFlowMacroContext,
): number {
  // Hard-coded 0 stub. Saturation curve for the real rewire lives in
  // `clusterScoreFromCount` (cross-name); bilateral will likely reuse
  // the same shape with its own count → score mapping.
  return 0;
}

// ── Cross-name cluster ────────────────────────────────────────

/**
 * `cross_name_cluster_score` ∈ [0, 1] — proxy for "N≥5 tickers from the
 * same sector all alerted within 5 min of this fire".
 *
 * STUB v1: the alert row does NOT carry the recent-cluster-count for the
 * sector lookup. The spec's macro arg accepts a `sectorMap` so the detect
 * cron CAN identify which sector the current alert belongs to, but the
 * count of co-firing same-sector tickers within a 5-min window is
 * sequential-context data that lives on the cron's pre-fetched recent-fires
 * pool — out of scope for this pure-function signature.
 *
 * Until either (a) the alert row carries
 * `sector_cluster_count_within_5min`, or (b) the macro arg is extended
 * with a `recentFiresBySector` map, this returns 0. Saturation logic is
 * fully implemented and tested below so the rewire is a 1-line swap.
 */
// STUB: see fn-doc. Saturation curve lives in `clusterScoreFromCount`
// for the eventual rewire — once the macro arg carries a
// `recentFiresBySector` map, this becomes
// `clusterScoreFromCount(countSameSectorWithin5Min(alert, macro))`.
function computeCrossNameClusterScore(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _alert: LotteryAlertRow | SilentBoomAlertRow,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _macro: ForcedFlowMacroContext,
): number {
  // Returns 0 directly (not via `clusterScoreFromCount(0)`) to make the
  // stub status legible at a glance vs the real path the rewire will use.
  return 0;
}

/**
 * Saturation curve for the cross-name cluster feature. Exposed so the
 * rewire phase can call it without re-deriving the constants. Pure;
 * deterministic.
 *
 *   count <  CROSS_NAME_CLUSTER_MIN_TICKERS         → 0
 *   count == CROSS_NAME_CLUSTER_MIN_TICKERS         → 0.5 (linear with N=10 cap)
 *   count >= CROSS_NAME_CLUSTER_SATURATION_TICKERS  → 1
 *   otherwise linear interpolation
 */
export function clusterScoreFromCount(count: number): number {
  if (!Number.isFinite(count)) return 0;
  if (count < CROSS_NAME_CLUSTER_MIN_TICKERS) return 0;
  if (count >= CROSS_NAME_CLUSTER_SATURATION_TICKERS) return 1;
  return count / CROSS_NAME_CLUSTER_SATURATION_TICKERS;
}

// ── Calendar adjacency ────────────────────────────────────────

/**
 * UTC-based check: is `date` in the last hour of the last trading day of
 * its UTC quarter? Two simplifications vs spec:
 *
 *   1. "Last trading day" → last weekday (Mon-Fri) of the quarter. The repo
 *      has no holiday calendar wired (US holidays would shift this by 1-2
 *      days a few times a year — a Jan-2 NYE roll, a Good-Friday shift,
 *      etc.). Documented as a v2 calendar-feed rewire.
 *
 *   2. CT vs UTC: trader cares about CT 14:00-15:00 (last cash hour). We
 *      convert via `getCTTime` to stay consistent with the rest of
 *      takeit-features.ts which uses CT throughout.
 *
 * Pure: no Date.now(), no I/O.
 */
export function isQuarterEndLastHourCt(triggerTimeCt: Date): boolean {
  // CT month/year derived from the same formatter the rest of takeit-features
  // uses so quarter-end semantics line up with the trader's session.
  // We extract CT date parts inline to avoid a transitive dep on getCTDateStr.
  let ctDateStr: string;
  try {
    ctDateStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(triggerTimeCt); // → 'YYYY-MM-DD'
  } catch {
    return false;
  }
  const parts = ctDateStr.split('-');
  if (parts.length !== 3) return false;
  const year = Number.parseInt(parts[0] ?? '', 10);
  const monthIdx = Number.parseInt(parts[1] ?? '', 10) - 1; // 0-11
  const day = Number.parseInt(parts[2] ?? '', 10);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(monthIdx) ||
    !Number.isFinite(day)
  )
    return false;

  // Quarter-end months in 0-indexed: Mar=2, Jun=5, Sep=8, Dec=11.
  const isQuarterEndMonth =
    monthIdx === 2 || monthIdx === 5 || monthIdx === 8 || monthIdx === 11;
  if (!isQuarterEndMonth) return false;

  // Find last weekday (Mon-Fri) of this CT month. Iterate backward from the
  // last calendar day to handle leap-Feb / month-length variation.
  // `new Date(Date.UTC(...))` then getUTCDay() avoids local-tz drift.
  // (Quarter-end months never fall in Feb; using calendar arithmetic is safe.)
  const daysInMonth = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
  let lastTradingDay = daysInMonth;
  for (let d = daysInMonth; d >= 1; d--) {
    const dow = new Date(Date.UTC(year, monthIdx, d)).getUTCDay();
    if (dow >= 1 && dow <= 5) {
      lastTradingDay = d;
      break;
    }
  }
  if (day !== lastTradingDay) return false;

  // Extract CT minute-of-day for the last-hour gate. We dodge the
  // transitive dep on getCTTime to keep this module's import surface tight;
  // the timezone helpers in src/utils/timezone.ts use the same Intl pattern.
  let ctTimeStr: string;
  try {
    ctTimeStr = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).format(triggerTimeCt); // → 'HH:MM'
  } catch {
    return false;
  }
  const timeParts = ctTimeStr.split(':');
  if (timeParts.length !== 2) return false;
  const hour = Number.parseInt(timeParts[0] ?? '', 10);
  const minute = Number.parseInt(timeParts[1] ?? '', 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;
  const minuteOfDay = hour * 60 + minute;
  return (
    minuteOfDay >= QUARTER_END_HOUR_START_CT &&
    minuteOfDay < QUARTER_END_HOUR_END_CT
  );
}

/**
 * `calendar_adjacency_flag` ∈ {0, 1} — fires when the trigger time falls in
 * a known mechanically-driven flow window:
 *
 *   - Quarter-end last hour of cash session (rebalance window) — FULLY WIRED
 *     using `isQuarterEndLastHourCt`.
 *   - Day-after-FOMC, day-after-CPI, day-after-NFP — STUBBED. The repo has
 *     an `economic_events` table populated by
 *     `api/cron/fetch-economic-calendar.ts` with `event_type ∈
 *     {FOMC, CPI, PCE, JOBS, GDP, PMI, RETAIL, SENTIMENT, OTHER}` but
 *     reading it requires I/O. Spec §"Data dependencies" defers this to v2;
 *     the rewire will inject `priorTradingDayEventTypes: Set<string>` into
 *     the macro arg.
 */
function computeCalendarAdjacencyFlag(
  alert: LotteryAlertRow | SilentBoomAlertRow,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _macro: ForcedFlowMacroContext,
): number {
  // Real component: quarter-end last-hour window. Pure CT-time gating.
  if (isQuarterEndLastHourCt(alert.fire_time)) return 1;
  // STUB component: day-after-FOMC/CPI/NFP. See fn-doc — pending v2 wire
  // (will read `_macro.priorTradingDayEventTypes` when populated).
  return 0;
}

// ── Cross-asset stress ────────────────────────────────────────

/**
 * `cross_asset_stress_flag` ∈ {0, 1} — fires when VIX intraday change is
 * strictly greater than +3pts. The strict-greater (not ≥) matches the spec
 * wording "VIX intraday change > +3pts at alert time"; a +3.00 print is on
 * the edge and is treated as "still in normal regime".
 *
 * Returns 0 when VIX data is unavailable (null / undefined). This is
 * truthful — "no signal available" — and aligns with the model's NaN-
 * default routing for missing categoricals.
 */
function computeCrossAssetStressFlag(macro: ForcedFlowMacroContext): number {
  const vix = macro.vixIntradayChange;
  if (vix === null || vix === undefined || !Number.isFinite(vix)) return 0;
  return vix > CROSS_ASSET_STRESS_VIX_THRESHOLD_PTS ? 1 : 0;
}

// ── Public composer ──────────────────────────────────────────

/**
 * Compose all 4 forced-flow features for a single alert. Pure; allocates
 * a fresh result object per call so callers can freely mutate the return
 * value without affecting cached macro state.
 *
 * Wired into `featuresForLottery` and `featuresForSilentBoom` in
 * takeit-features.ts — the 4 keys are spread into the base feature record
 * alongside existing numerics. Bundle.feature_cols decides which of them
 * (or all) the model consumes at scoring time.
 */
export function computeForcedFlowFeatures(
  alert: LotteryAlertRow | SilentBoomAlertRow,
  macro: ForcedFlowMacroContext,
): ForcedFlowFeatures {
  return {
    bilateral_flow_score: computeBilateralFlowScore(alert, macro),
    cross_name_cluster_score: computeCrossNameClusterScore(alert, macro),
    calendar_adjacency_flag: computeCalendarAdjacencyFlag(alert, macro),
    cross_asset_stress_flag: computeCrossAssetStressFlag(macro),
  };
}
