/**
 * Strike IV Anomaly Detector — Phase 2 detection module.
 *
 * Pure functions that consume Phase 1's `strike_iv_snapshots` rows
 * (ingested by `api/cron/fetch-strike-iv.ts`) and flag strikes whose
 * IV move meets at least one of:
 *
 *   1. **Cross-strike skew delta** — target strike IV minus the average
 *      IV of its 2 neighbors each side (same ticker / side / expiry,
 *      most recent sample). Removes the common charm/gamma factor so
 *      only idiosyncratic demand remains.
 *
 *   2. **Rolling Z-score** — target strike's iv_mid change vs its own
 *      Z_WINDOW_SIZE-sample history. Filters constant decay drift.
 *
 *   3. **Ask-mid IV divergence** — iv_ask − iv_mid. Tracked on every
 *      anomaly but NOT a standalone gate per spec (spec §Thresholds:
 *      "Tracked separately, not a gate"). It serves as a supporting
 *      signal when the other two fire.
 *
 * Side-skew gate (replaces the IV-spread proxy as of 2026-04-28): uses
 * cumulative-since-open bid/ask volume from `strike_trade_volume`. Old
 * proxy was systematically inverted on penny-priced ETF options because
 * Schwab's `mark` snaps to `ask` on those, pinning iv_mid at iv_ask.
 * Caller passes `tapeByKey` keyed on `${ticker}:${strike}:${side}` (NO
 * expiry — UW's flow-per-strike-intraday aggregates across expiries).
 * See: docs/superpowers/specs/iv-anomaly-real-tape-bidask-2026-04-28.md.
 *
 * The module is side-effect-free: it takes samples + history + tape in
 * and emits a list of `AnomalyFlag` rows the caller persists into the
 * `iv_anomalies` table. Context capture lives in `anomaly-context.ts`.
 */

import {
  SKEW_DELTA_THRESHOLD,
  Z_SCORE_THRESHOLD,
  ASK_MID_DIV_THRESHOLD,
  RESOLVE_FLAT_PNL_THRESHOLD,
  RESOLVE_FAST_PEAK_MINS,
  VOL_OI_RATIO_THRESHOLD,
  IV_SIDE_SKEW_THRESHOLD,
} from './constants.js';
import { blackScholesPrice } from '../../src/utils/black-scholes.js';
import { getETCloseUtcIso } from '../../src/utils/timezone.js';
import type { ContextSnapshot } from './anomaly-context.js';

// ── Public types ──────────────────────────────────────────────

export interface StrikeSample {
  ticker: string;
  strike: number;
  side: 'call' | 'put';
  /** ISO date (YYYY-MM-DD). */
  expiry: string;
  iv_mid: number | null;
  iv_bid: number | null;
  iv_ask: number | null;
  /** Cumulative intraday volume. Null when Schwab returns NaN/missing. */
  volume: number | null;
  /** Start-of-day open interest. Null when Schwab returns NaN/missing. */
  oi: number | null;
  /** ISO timestamp (UTC). */
  ts: string;
}

/**
 * Cumulative-since-open tape volume splits for one (ticker, strike, side).
 * `bid_pct + ask_pct + mid_pct` should sum to ~1.0 (rounding). Caller
 * aggregates `SUM(*)` from `strike_trade_volume` for the trading day up
 * to the detection ts, then divides each side by `total_vol`.
 */
export interface TapeStats {
  bid_pct: number;
  ask_pct: number;
  mid_pct: number;
  total_vol: number;
}

/**
 * Tape lookup key — `${ticker}:${strike}:${side}`. Note: NO expiry.
 * `strike_trade_volume` aggregates across expiries by design (UW's
 * flow-per-strike-intraday endpoint reports per-strike, expiry-agnostic).
 */
export function tapeKey(
  ticker: string,
  strike: number,
  side: 'call' | 'put',
): string {
  return `${ticker}:${strike}:${side}`;
}

export interface AnomalyFlag {
  ticker: string;
  strike: number;
  side: 'call' | 'put';
  expiry: string;
  spot_at_detect: number;
  iv_at_detect: number;
  /** Target IV − mean(IV of 2 neighbors each side). Null when < 4 neighbors. */
  skew_delta: number | null;
  /** Rolling Z over last Z_WINDOW_SIZE iv_mid samples. Null when < 10 history. */
  z_score: number | null;
  /** iv_ask − iv_mid. Null when bid/ask IV couldn't be inverted. */
  ask_mid_div: number | null;
  /**
   * Intraday volume / start-of-day OI at detection. Null only when the
   * upstream Schwab row didn't surface both values (should never happen
   * in practice — gate would have rejected the strike earlier). Included
   * on every flag for observability in the UI and downstream ML slicing.
   */
  vol_oi_ratio: number | null;
  /**
   * `max(ask_pct, bid_pct)` at detection time — fraction of the day's
   * cumulative volume on this strike that printed on the dominant side.
   * 0.5 = balanced two-sided flow, 1.0 = every print was on the same
   * side. Same numeric range as the legacy IV-spread proxy so existing
   * UI/threshold code keeps working; semantics are now real volume.
   */
  side_skew: number | null;
  /**
   * Which side dominated cumulative volume at detection time:
   *   - 'ask'   — buyers lifting the offer (≥ IV_SIDE_SKEW_THRESHOLD of
   *               total tape volume printed at the ask).
   *   - 'bid'   — sellers hitting the bid (≥ threshold printed at the bid).
   *   - 'mixed' — neither side clears the gate (two-sided / pin trade).
   *               Filtered out before reaching `flags`; present for
   *               type-completeness only.
   *   - null    — no tape rows for this strike yet today (also filtered).
   */
  side_dominant: 'ask' | 'bid' | 'mixed' | null;
  /**
   * Fraction of cumulative tape volume that printed at the bid. 0..1.
   * Null on legacy rows pre-migration 95 (real-tape gate replaced the
   * IV-spread proxy on 2026-04-28).
   */
  bid_pct: number | null;
  /** Fraction at the ask. 0..1. See `bid_pct`. */
  ask_pct: number | null;
  /**
   * Fraction in the middle (neither at bid nor ask). 0..1. UW's
   * flow-per-strike-intraday classifies these as "no side determined" —
   * pin trades, mid-market crosses, etc.
   */
  mid_pct: number | null;
  /**
   * Total tape volume on this strike today up to detection ts.
   * Denominator for `bid_pct/ask_pct/mid_pct`. Null pre-migration 95.
   */
  total_vol_at_detect: number | null;
  /** Non-empty; contains any combination of 'skew_delta', 'z_score'. */
  flag_reasons: string[];
  /**
   * Populated by `classifyFlowPhase` once a `ContextSnapshot` is
   * available. Left `undefined` by `detectAnomalies` so a caller that
   * skips the classification step gets a type-level reminder rather
   * than a silent `'mid'` fallback.
   */
  flow_phase?: 'early' | 'mid' | 'reactive';
  /** Detection time (ISO UTC). */
  ts: string;
}

/** Minimum sample count before Z-score is considered reliable. */
const Z_MIN_SAMPLES = 10;

// ── Helpers ──────────────────────────────────────────────────

/**
 * Stable composite key for indexing history maps + neighbor lookups.
 */
export function strikeKey(
  ticker: string,
  strike: number,
  side: 'call' | 'put',
  expiry: string,
): string {
  return `${ticker}:${strike}:${side}:${expiry}`;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

// ── Skew delta ───────────────────────────────────────────────

/**
 * Target strike IV minus the average IV of 2 neighbors each side.
 *
 * Neighbors must be the same ticker / side / expiry; the caller is
 * responsible for the filtering. Expects exactly up to 4 neighbors —
 * if fewer than 4 are provided (edge of the OTM band), returns null
 * rather than fabricating a delta from a lopsided window.
 *
 * Convention: the returned value is in percentage points of IV (e.g.
 * iv_mid is 0.42 for 42% vol). Thresholds compare to `SKEW_DELTA_THRESHOLD`
 * expressed in **vol points**, i.e. 0.015 for 1.5 vol pts.
 */
export function computeSkewDelta(
  target: StrikeSample,
  neighbors: StrikeSample[],
): number | null {
  if (target.iv_mid == null || !isFiniteNumber(target.iv_mid)) return null;

  const usable = neighbors
    .filter((n) => n.iv_mid != null && isFiniteNumber(n.iv_mid))
    .map((n) => n.iv_mid as number);

  // Require the full 4-neighbor window to avoid edge-of-band false positives.
  if (usable.length < 4) return null;

  const mean = usable.reduce((s, v) => s + v, 0) / usable.length;
  return target.iv_mid - mean;
}

// ── Rolling Z ────────────────────────────────────────────────

/**
 * Target strike's iv_mid Z-score vs its own rolling baseline.
 *
 * `history` is the last N iv_mid samples for this same strike/side/
 * expiry/ticker, ordered DESC by ts (newest first) with the target
 * sample EXCLUDED. We require ≥ `Z_MIN_SAMPLES` usable iv_mid values
 * before emitting a number — low-sample sessions return null and the
 * detector falls back to skew delta alone.
 *
 * Uses population stddev (divide by N, not N-1). For N=60 the
 * difference is negligible and population is what we want when the
 * window IS our "baseline population" (vs treating it as a sample of
 * some larger distribution).
 */
export function computeRollingZ(
  target: StrikeSample,
  history: StrikeSample[],
): number | null {
  if (target.iv_mid == null || !isFiniteNumber(target.iv_mid)) return null;

  const series = history
    .map((h) => h.iv_mid)
    .filter((v): v is number => v != null && isFiniteNumber(v));

  if (series.length < Z_MIN_SAMPLES) return null;

  const mean = series.reduce((s, v) => s + v, 0) / series.length;
  const variance =
    series.reduce((s, v) => s + (v - mean) ** 2, 0) / series.length;
  const stddev = Math.sqrt(variance);

  // Guard against zero-variance history (all samples identical). Floating-
  // point math leaves a tiny positive stddev in that case, so use an
  // epsilon rather than a strict `> 0` check — a stddev below 1e-6 means
  // the strike has been pinned and the z-score is not informative.
  if (!Number.isFinite(stddev) || stddev < 1e-6) return null;

  return (target.iv_mid - mean) / stddev;
}

// ── Ask-mid divergence ───────────────────────────────────────

function computeAskMidDiv(sample: StrikeSample): number | null {
  if (
    sample.iv_ask == null ||
    sample.iv_mid == null ||
    !isFiniteNumber(sample.iv_ask) ||
    !isFiniteNumber(sample.iv_mid)
  ) {
    return null;
  }
  return sample.iv_ask - sample.iv_mid;
}

// ── detectAnomalies ──────────────────────────────────────────

/**
 * Scan the latest per-strike snapshot and emit a flag for every
 * strike whose skew delta or rolling Z exceeds threshold.
 *
 * Neighbors are picked from `latestSnapshot` by sorting same-side /
 * same-expiry / same-ticker samples by strike, finding the target,
 * then taking up to 2 above + 2 below. No guarantee all 4 exist at
 * the band edges — see `computeSkewDelta` for the null-fallback.
 *
 * `historyByStrike` keys are `ticker:strike:side:expiry` (see
 * `strikeKey()`). Values are history arrays DESC-sorted by ts and
 * MUST NOT include the target sample (the caller's SQL query
 * should WHERE ts < target.ts).
 *
 * The returned flags leave `flow_phase` undefined — callers must run
 * `classifyFlowPhase(flag, context)` once a `ContextSnapshot` is
 * assembled, then use that value for persistence.
 *
 * `tapeByKey` keys are `tapeKey(ticker, strike, side)` — no expiry. The
 * caller aggregates `strike_trade_volume` for today up to the detection
 * ts. Strikes with no tape row are dropped (the gate cannot judge
 * directionality without prints).
 */
export function detectAnomalies(
  latestSnapshot: StrikeSample[],
  historyByStrike: Map<string, StrikeSample[]>,
  tapeByKey: Map<string, TapeStats>,
  spot: number,
): AnomalyFlag[] {
  if (!isFiniteNumber(spot) || spot <= 0) return [];

  // Group latestSnapshot by (ticker, side, expiry) so we can pick
  // neighbors on the same axis in O(n log n).
  const groups = new Map<string, StrikeSample[]>();
  for (const s of latestSnapshot) {
    const key = `${s.ticker}:${s.side}:${s.expiry}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(s);
    else groups.set(key, [s]);
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => a.strike - b.strike);
  }

  const flags: AnomalyFlag[] = [];

  for (const target of latestSnapshot) {
    if (target.iv_mid == null || !isFiniteNumber(target.iv_mid)) continue;

    // PRIMARY GATE: vol/OI must be massively outsized.
    //
    // Applied BEFORE any IV signal check — the 2026-04-24 production run
    // showed that low-vol/OI strikes generate noise even when the IV
    // signals trip. Only strikes that traders are actively piling into
    // (cumulative intraday volume ≥ 5× start-of-day OI) clear the gate.
    //
    // Guard against oi = 0 (rare but possible: newly-listed strike) —
    // division by zero would produce Infinity and pass any >= test, which
    // is the opposite of what we want. `null` or `0` OI → skip.
    if (
      target.volume == null ||
      !isFiniteNumber(target.volume) ||
      target.oi == null ||
      !isFiniteNumber(target.oi) ||
      target.oi === 0
    ) {
      continue;
    }
    const volOiRatio = target.volume / target.oi;
    if (!Number.isFinite(volOiRatio) || volOiRatio < VOL_OI_RATIO_THRESHOLD) {
      continue;
    }

    // SECONDARY GATE: real tape-side dominance.
    //
    // Filters out 2-sided unwinding noise (e.g., 0DTE strikes pin-trading
    // at 50/50 ask/bid) that the vol/OI gate alone can't see — those
    // strikes can have outsized vol/OI when holders are ROLLING positions
    // through the same strike. Real informed flow shows up as bid_pct → 1
    // (distribution) or ask_pct → 1 (accumulation).
    //
    // Uses cumulative-since-open bid/ask volume from strike_trade_volume.
    // No tape rows = strike hasn't traded today (or sub-minute lag from
    // the tape cron) — skip rather than emit a degraded flag. The vol/OI
    // gate above already required meaningful Schwab volume, so a strike
    // with zero UW tape is a real anomaly worth dropping.
    const tapeStats = tapeByKey.get(
      tapeKey(target.ticker, target.strike, target.side),
    );
    if (!tapeStats || tapeStats.total_vol <= 0) continue;
    const sideSkew = Math.max(tapeStats.ask_pct, tapeStats.bid_pct);
    if (sideSkew < IV_SIDE_SKEW_THRESHOLD) continue;
    const sideDominant: 'ask' | 'bid' =
      tapeStats.ask_pct >= tapeStats.bid_pct ? 'ask' : 'bid';

    const groupKey = `${target.ticker}:${target.side}:${target.expiry}`;
    const group = groups.get(groupKey) ?? [];
    const idx = group.findIndex(
      (s) => s.strike === target.strike && s.ts === target.ts,
    );
    // If the target isn't in the snapshot (shouldn't happen), skip.
    if (idx < 0) continue;

    const neighbors = [
      ...group.slice(Math.max(0, idx - 2), idx),
      ...group.slice(idx + 1, idx + 3),
    ];

    const skewDelta = computeSkewDelta(target, neighbors);
    const history =
      historyByStrike.get(
        strikeKey(target.ticker, target.strike, target.side, target.expiry),
      ) ?? [];
    const zScore = computeRollingZ(target, history);
    const askMidDiv = computeAskMidDiv(target);

    const reasons: string[] = [];
    if (skewDelta != null && Math.abs(skewDelta) > SKEW_DELTA_THRESHOLD / 100) {
      reasons.push('skew_delta');
    }
    if (zScore != null && Math.abs(zScore) > Z_SCORE_THRESHOLD) {
      reasons.push('z_score');
    }

    if (reasons.length === 0) continue;

    flags.push({
      ticker: target.ticker,
      strike: target.strike,
      side: target.side,
      expiry: target.expiry,
      spot_at_detect: spot,
      iv_at_detect: target.iv_mid,
      skew_delta: skewDelta,
      z_score: zScore,
      ask_mid_div: askMidDiv,
      vol_oi_ratio: volOiRatio,
      side_skew: sideSkew,
      side_dominant: sideDominant,
      bid_pct: tapeStats.bid_pct,
      ask_pct: tapeStats.ask_pct,
      mid_pct: tapeStats.mid_pct,
      total_vol_at_detect: tapeStats.total_vol,
      flag_reasons: reasons,
      // flow_phase intentionally omitted — see classifyFlowPhase.
      ts: target.ts,
    });
  }

  return flags;
}

// ── Flow phase classification ────────────────────────────────

/**
 * Label the anomaly as `early | mid | reactive` for ML slicing.
 *
 * Separates tradeable alpha (`early` — flow arrives before the tape
 * moves) from chase / hedge noise (`reactive` — flow follows price
 * and VIX expansion). Heuristic is intentionally simple — each axis
 * contributes one point; the final label is the category with the
 * highest score, ties broken toward `mid`.
 *
 * Axes:
 *   - **Spot-vs-strike distance**: far OTM = early, near ATM = reactive.
 *     Threshold: < 0.5% of spot = reactive, > 2% = early, else mid.
 *   - **VIX delta (15m)**: quiet = early, spiking = reactive.
 *     Threshold: |Δ| < 0.3 pts = early, |Δ| > 0.8 = reactive, else mid.
 *   - **ASK-skew persistence proxy**: we don't have a time-series for
 *     ask_mid_div here, so we use the current value. Large ask-mid
 *     divergence AT detect = "fresh" (early). We weight this axis
 *     less — 0.5 point — because it's a single-snapshot proxy.
 */
export function classifyFlowPhase(
  anomaly: AnomalyFlag,
  contextSnapshot: ContextSnapshot,
): 'early' | 'mid' | 'reactive' {
  let earlyScore = 0;
  let reactiveScore = 0;

  // Spot-vs-strike distance.
  const distPct = Math.abs(
    (anomaly.strike - anomaly.spot_at_detect) / anomaly.spot_at_detect,
  );
  if (distPct > 0.02) earlyScore += 1;
  else if (distPct < 0.005) reactiveScore += 1;

  // VIX expansion.
  const vixDelta15m = contextSnapshot.vix_delta_15m;
  if (vixDelta15m != null && Number.isFinite(vixDelta15m)) {
    const absVix = Math.abs(vixDelta15m);
    if (absVix < 0.3) earlyScore += 1;
    else if (absVix > 0.8) reactiveScore += 1;
  }

  // Ask-mid divergence as a fresh-flow proxy.
  if (
    anomaly.ask_mid_div != null &&
    anomaly.ask_mid_div > ASK_MID_DIV_THRESHOLD / 100
  ) {
    earlyScore += 0.5;
  }

  if (earlyScore > reactiveScore) return 'early';
  if (reactiveScore > earlyScore) return 'reactive';
  return 'mid';
}

// ── resolveAnomaly (Phase 4) ─────────────────────────────────

/**
 * Per-minute follow-on sample used by `resolveAnomaly`.
 *
 * `ts` must be ≥ the anomaly's detection time — callers should WHERE by
 * `ts >= anomaly.ts` and `ts <= close_ts` when loading from the
 * `strike_iv_snapshots` table.
 */
export interface FollowOnSample {
  /** ISO timestamp (UTC). */
  ts: string;
  /** iv_mid at this sample. May be null when the solver couldn't invert. */
  iv_mid: number | null;
  /** Underlying spot at this sample. */
  spot: number;
}

/**
 * Minimal shape of an `iv_anomalies` row that `resolveAnomaly` needs to
 * compute an outcome. The full DB row has more columns — the caller
 * projects it down before calling this pure function.
 */
export interface AnomalyForResolve {
  ticker: string;
  strike: number;
  side: 'call' | 'put';
  /** ISO date (YYYY-MM-DD). */
  expiry: string;
  spot_at_detect: number;
  iv_at_detect: number;
  /** ISO timestamp (UTC). */
  ts: string;
}

/** The `resolution_outcome` JSONB shape minus the `catalysts` sub-object. */
export interface ResolveEconomics {
  iv_at_detect: number;
  iv_peak: number;
  iv_at_close: number;
  spot_at_detect: number;
  spot_min: number;
  spot_max: number;
  spot_at_close: number;
  notional_1c_pnl: number;
  mins_to_peak: number;
  outcome_class: 'winner_fast' | 'winner_slow' | 'flat' | 'loser';
}

/**
 * Score an anomaly's trade economics over the rest of the session.
 *
 * Pure function — no DB / no logger. Given the detected anomaly and the
 * per-minute follow-on samples between detection and close, computes:
 *
 *   - **iv_peak / iv_at_close**: max iv_mid in the window / iv_mid at the
 *     last sample (or null-iv fallback → iv_at_detect).
 *   - **spot_min / spot_max / spot_at_close**: trivial from the series.
 *   - **notional_1c_pnl**: hypothetical 1-contract P&L. We use
 *     Black-Scholes to price the strike at detection (spot_at_detect,
 *     iv_at_detect, T_detect) and at close (spot_at_close, iv_at_close,
 *     T_close), then take the dollar-denominated difference × 100 (the
 *     standard SPX/SPY/QQQ contract multiplier). This is "trader would
 *     have opened at mid and closed at mid" — no slippage adjustment
 *     since the detector outputs are the labeling input, not a live
 *     order-sizing tool.
 *   - **mins_to_peak**: minutes from anomaly.ts to the sample with the
 *     highest iv_mid.
 *   - **outcome_class**: derived from |notional_1c_pnl| vs flat threshold
 *     and mins_to_peak vs fast-peak cutoff (see constants).
 *
 * `closeTs` is the 4pm ET close for anomaly.ts's trading day; callers
 * pass it explicitly rather than re-computing from the ts to avoid
 * timezone drift inside this pure module.
 *
 * Edge cases:
 *   - Empty `samples` array → returns detect-equals-close economics with
 *     outcome 'flat' (anomaly near close / no follow-on data).
 *   - All samples have null iv_mid → iv_peak / iv_at_close fall back
 *     to iv_at_detect; the trade effectively didn't move, so the P&L
 *     is computed from spot change alone.
 */
export function resolveAnomaly(
  anomaly: AnomalyForResolve,
  samples: FollowOnSample[],
  closeTs: string,
): ResolveEconomics {
  const detectMs = Date.parse(anomaly.ts);
  const closeMs = Date.parse(closeTs);

  // Time-to-expiry helper (years, 4pm ET close on expiry date as
  // settlement reference — matches fetch-strike-iv.ts convention).
  // getETCloseUtcIso is DST-aware; fall back to 21:00 UTC (EST) only if
  // the expiry string is malformed, which would already be filtered
  // upstream. The fallback never fires on valid ET calendar dates.
  const expiryCloseIso =
    getETCloseUtcIso(anomaly.expiry) ?? `${anomaly.expiry}T21:00:00Z`;
  const expiryMs = Date.parse(expiryCloseIso);
  const YEAR_MS = 365 * 24 * 3600 * 1000;
  const tAt = (ms: number): number => Math.max(expiryMs - ms, 60_000) / YEAR_MS;

  // Defensive: drop samples outside (anomaly.ts, closeTs] and non-finite
  // iv/spot rows. Preserve detection-time fallback when nothing valid remains.
  const usable = samples.filter((s) => {
    const ms = Date.parse(s.ts);
    if (!Number.isFinite(ms)) return false;
    if (ms <= detectMs) return false;
    if (ms > closeMs) return false;
    return Number.isFinite(s.spot) && s.spot > 0;
  });

  // iv_peak / mins_to_peak — anchor to detection so the degenerate case
  // (no post-detection expansion) yields mins_to_peak = 0.
  let ivPeak = anomaly.iv_at_detect;
  let ivPeakMs = detectMs;
  for (const s of usable) {
    if (s.iv_mid == null) continue;
    if (!Number.isFinite(s.iv_mid)) continue;
    if (s.iv_mid > ivPeak) {
      ivPeak = s.iv_mid;
      ivPeakMs = Date.parse(s.ts);
    }
  }
  const minsToPeak = Math.max(0, (ivPeakMs - detectMs) / 60_000);

  // iv_at_close — latest usable iv_mid, or fall back to iv_at_detect if
  // the whole tail is null (Schwab can return dead quotes into close).
  let ivAtClose = anomaly.iv_at_detect;
  for (let i = usable.length - 1; i >= 0; i -= 1) {
    const s = usable[i]!;
    if (s.iv_mid != null && Number.isFinite(s.iv_mid)) {
      ivAtClose = s.iv_mid;
      break;
    }
  }

  // spot_min / spot_max / spot_at_close.
  let spotMin = anomaly.spot_at_detect;
  let spotMax = anomaly.spot_at_detect;
  let spotAtClose = anomaly.spot_at_detect;
  let latestMs = detectMs;
  for (const s of usable) {
    if (s.spot < spotMin) spotMin = s.spot;
    if (s.spot > spotMax) spotMax = s.spot;
    const sMs = Date.parse(s.ts);
    if (sMs >= latestMs) {
      latestMs = sMs;
      spotAtClose = s.spot;
    }
  }

  // Notional 1-contract P&L. Price at detect + price at close via BS,
  // delta × 100 (SPX/SPY/QQQ all 100-multiplier).
  const priceAtDetect = blackScholesPrice(
    anomaly.spot_at_detect,
    anomaly.strike,
    anomaly.iv_at_detect,
    tAt(detectMs),
    anomaly.side,
  );
  const priceAtClose = blackScholesPrice(
    spotAtClose,
    anomaly.strike,
    ivAtClose,
    tAt(latestMs),
    anomaly.side,
  );
  const notional1cPnl = (priceAtClose - priceAtDetect) * 100;

  // Outcome class.
  let outcomeClass: ResolveEconomics['outcome_class'];
  if (notional1cPnl > RESOLVE_FLAT_PNL_THRESHOLD) {
    outcomeClass =
      minsToPeak < RESOLVE_FAST_PEAK_MINS ? 'winner_fast' : 'winner_slow';
  } else if (notional1cPnl < -RESOLVE_FLAT_PNL_THRESHOLD) {
    outcomeClass = 'loser';
  } else {
    outcomeClass = 'flat';
  }

  return {
    iv_at_detect: anomaly.iv_at_detect,
    iv_peak: ivPeak,
    iv_at_close: ivAtClose,
    spot_at_detect: anomaly.spot_at_detect,
    spot_min: spotMin,
    spot_max: spotMax,
    spot_at_close: spotAtClose,
    notional_1c_pnl: notional1cPnl,
    mins_to_peak: minsToPeak,
    outcome_class: outcomeClass,
  };
}
