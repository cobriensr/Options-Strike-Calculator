/**
 * Strike IV Anomaly Detector — Phase 4 retrospective catalyst analysis.
 *
 * Given an anomaly's detection time + its already-captured
 * `context_snapshot` + time series from a handful of cross-asset sources,
 * scan the T-60 → T+0 window and tell us WHAT MOVED FIRST. The output
 * is the `catalysts` sub-object of `resolution_outcome`:
 *
 *   - **leading_assets** — for each cross-asset time series where
 *     |Pearson(returns)| > CATALYST_CORR_THRESHOLD, record ticker,
 *     correlation, and the cross-correlation argmax lag in minutes.
 *     Positive lag = the cross-asset moved FIRST (led the anomaly
 *     ticker's tape).
 *
 *   - **large_dark_prints** — UW dark-pool prints inside the window
 *     above CATALYST_LARGE_DARK_NOTIONAL notional dollars.
 *
 *   - **flow_alerts_in_window** — UW flow alerts on the anomaly
 *     ticker inside the window.
 *
 *   - **likely_catalyst** — narrative tag built from whichever
 *     `leading_asset` has the tightest |correlation| AND lead time
 *     >= CATALYST_NARRATIVE_LAG_MIN_MINS AND |correlation| >=
 *     CATALYST_NARRATIVE_CORR_MIN. Falls back to 'unknown' when
 *     nothing qualifies.
 *
 * This module is a **pure function** — no DB, no logger, no Sentry.
 * The resolve-iv-anomalies cron assembles the time series + event
 * rows from DB queries and hands them to `analyzeCatalysts()`, then
 * persists the returned `Catalysts` object as `resolution_outcome.
 * catalysts`. Tests supply synthetic time series to verify the
 * correlation math + narrative heuristic.
 */

import {
  CATALYST_CORR_THRESHOLD,
  CATALYST_LARGE_DARK_NOTIONAL,
  CATALYST_NARRATIVE_CORR_MIN,
  CATALYST_NARRATIVE_LAG_MIN_MINS,
  CATALYST_WINDOW_MINS,
} from './constants.js';
import type { ContextSnapshot } from './anomaly-context.js';

// ── Public types ──────────────────────────────────────────────

export interface Catalysts {
  leading_assets: Array<{
    ticker: string;
    lag_mins: number;
    correlation: number;
  }>;
  large_dark_prints: Array<{ ticker: string; ts: string; notional: number }>;
  flow_alerts_in_window: Array<{
    ts: string;
    ticker: string;
    premium: number;
  }>;
  likely_catalyst: string;
}

/** Single-asset 1-minute spot time series inside the T-60 window. */
export interface CrossAssetSeries {
  ticker: string;
  /** DESC- or ASC-ordered samples by ts; the analyzer normalises. */
  samples: Array<{ ts: string; spot: number }>;
}

/**
 * Time series that `analyzeCatalysts` correlates against each
 * cross-asset. The anomaly ticker's own spot trajectory inside the
 * T-60 window.
 */
export interface AnomalySeries {
  ticker: string;
  samples: Array<{ ts: string; spot: number }>;
}

/** Single dark-print candidate row. */
export interface DarkPrintRow {
  ticker: string;
  ts: string;
  /** Notional dollar value of the print (post-filter — see module doc). */
  notional: number;
}

/** Single flow-alert row. */
export interface FlowAlertRow {
  ts: string;
  ticker: string;
  premium: number;
}

/** Anomaly identity + detection time. */
export interface AnomalyForCatalyst {
  ticker: string;
  /** ISO timestamp. */
  ts: string;
  side: 'call' | 'put';
}

// ── Math helpers ──────────────────────────────────────────────

/**
 * Align two time-ordered spot series onto a common 1-minute minute-of-day
 * grid and compute log-returns for each.
 *
 * Returns null when fewer than 5 matched minutes are available — the
 * correlation/lag math below would fire zero-variance or 2-sample fits
 * that aren't informative.
 */
function alignReturns(
  a: Array<{ ts: string; spot: number }>,
  b: Array<{ ts: string; spot: number }>,
): { aRet: number[]; bRet: number[] } | null {
  if (a.length < 2 || b.length < 2) return null;

  // Bucket each series by minute-of-epoch (floor). If multiple samples
  // land in the same minute, keep the latest.
  const aByMin = new Map<number, number>();
  for (const s of a) {
    const ms = Date.parse(s.ts);
    if (!Number.isFinite(ms)) continue;
    if (!Number.isFinite(s.spot) || s.spot <= 0) continue;
    aByMin.set(Math.floor(ms / 60_000), s.spot);
  }
  const bByMin = new Map<number, number>();
  for (const s of b) {
    const ms = Date.parse(s.ts);
    if (!Number.isFinite(ms)) continue;
    if (!Number.isFinite(s.spot) || s.spot <= 0) continue;
    bByMin.set(Math.floor(ms / 60_000), s.spot);
  }

  // Common minute grid (intersection).
  const commonMinutes = [...aByMin.keys()]
    .filter((m) => bByMin.has(m))
    .sort((x, y) => x - y);

  if (commonMinutes.length < 3) return null;

  // Build aligned spot arrays, then log-returns between consecutive mins.
  const aSpots: number[] = [];
  const bSpots: number[] = [];
  for (const m of commonMinutes) {
    aSpots.push(aByMin.get(m)!);
    bSpots.push(bByMin.get(m)!);
  }

  const aRet: number[] = [];
  const bRet: number[] = [];
  for (let i = 1; i < aSpots.length; i += 1) {
    const aPrev = aSpots[i - 1]!;
    const bPrev = bSpots[i - 1]!;
    const aCur = aSpots[i]!;
    const bCur = bSpots[i]!;
    if (aPrev <= 0 || bPrev <= 0) continue;
    aRet.push(Math.log(aCur / aPrev));
    bRet.push(Math.log(bCur / bPrev));
  }

  if (aRet.length < 5) return null;

  return { aRet, bRet };
}

/** Pearson correlation coefficient. Returns null on zero variance / too few. */
function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i += 1) {
    sumX += xs[i]!;
    sumY += ys[i]!;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  if (dx2 < 1e-12 || dy2 < 1e-12) return null;
  const denom = Math.sqrt(dx2 * dy2);
  const r = num / denom;
  if (!Number.isFinite(r)) return null;
  // Guard numeric overshoot.
  if (r > 1) return 1;
  if (r < -1) return -1;
  return r;
}

/**
 * Cross-correlation argmax: for each lag in [-maxLag, +maxLag], shift
 * `leadSeries` forward by lag minutes and compute Pearson against the
 * lagged `followSeries`. Return the (lag, corr) pair with the largest
 * |corr|. Positive lag = leadSeries moved FIRST (leads the follow series).
 *
 * Keeps the search bounded — 15 minutes of lag ≈ a quarter of the T-60
 * window is plenty and keeps test fixtures compact.
 */
function crossCorrelate(
  leadRet: number[],
  followRet: number[],
  maxLag = 15,
): { lag: number; corr: number } | null {
  const n = Math.min(leadRet.length, followRet.length);
  if (n < 5) return null;

  let bestLag = 0;
  let bestAbs = -1;
  let bestSigned = 0;

  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    // At lag > 0: leadRet[t] correlates with followRet[t+lag], so we
    // pair lead[0..n-lag-1] with follow[lag..n-1]. Lag < 0 flips.
    let xs: number[];
    let ys: number[];
    if (lag >= 0) {
      xs = leadRet.slice(0, n - lag);
      ys = followRet.slice(lag, n);
    } else {
      xs = leadRet.slice(-lag, n);
      ys = followRet.slice(0, n + lag);
    }
    if (xs.length < 5) continue;
    const r = pearson(xs, ys);
    if (r == null) continue;
    const absR = Math.abs(r);
    if (absR > bestAbs) {
      bestAbs = absR;
      bestLag = lag;
      bestSigned = r;
    }
  }

  if (bestAbs < 0) return null;
  return { lag: bestLag, corr: bestSigned };
}

// ── Window / selection helpers ────────────────────────────────

function inWindow(ts: string, startMs: number, endMs: number): boolean {
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return false;
  return ms >= startMs && ms <= endMs;
}

function trimToWindow(
  samples: Array<{ ts: string; spot: number }>,
  startMs: number,
  endMs: number,
): Array<{ ts: string; spot: number }> {
  return samples.filter((s) => inWindow(s.ts, startMs, endMs));
}

// ── Narrative heuristic ──────────────────────────────────────

/**
 * Build the `likely_catalyst` narrative tag from the ranked
 * `leading_assets` plus the anomaly's own side.
 *
 * Heuristic:
 *   - Pick the lead asset with max |correlation|.
 *   - If its |correlation| >= CATALYST_NARRATIVE_CORR_MIN AND
 *     lag_mins >= CATALYST_NARRATIVE_LAG_MIN_MINS, emit
 *     "<lead_ticker> <direction> → <anomaly_ticker> <anomaly_direction>"
 *     where direction is derived from the sign of correlation crossed
 *     with the anomaly side (put anomaly + negative correlation = lead
 *     asset bid, anomaly ticker flushed).
 *   - Otherwise, return 'unknown'.
 *
 * This is deliberately coarse — the string is a hint for quick
 * retrospective review, not an ML feature. The structured
 * leading_assets array carries the real signal for later phases.
 */
function buildLikelyCatalyst(
  anomaly: AnomalyForCatalyst,
  leadingAssets: Catalysts['leading_assets'],
): string {
  // Find the asset with max |correlation| that also meets the lag gate.
  let best: Catalysts['leading_assets'][number] | null = null;
  for (const la of leadingAssets) {
    if (Math.abs(la.correlation) < CATALYST_NARRATIVE_CORR_MIN) continue;
    if (la.lag_mins < CATALYST_NARRATIVE_LAG_MIN_MINS) continue;
    if (best == null || Math.abs(la.correlation) > Math.abs(best.correlation)) {
      best = la;
    }
  }
  if (best == null) return 'unknown';

  // Narrative direction mapping. The anomaly is on `anomaly.side`; a
  // put anomaly almost always implies downside hedging / bearish pricing.
  // Sign of correlation + anomaly side:
  //   put + positive corr  → lead asset dropped first, anomaly ticker followed down
  //   put + negative corr  → lead asset bid first, anomaly ticker flushed (classic TLT→SPX)
  //   call + positive corr → lead asset rose first, anomaly ticker followed up
  //   call + negative corr → lead asset flushed, anomaly ticker ripped (risk-off→risk-on rotation)
  let leadDirection: string;
  let followDirection: string;
  if (anomaly.side === 'put') {
    if (best.correlation >= 0) {
      leadDirection = 'flush';
      followDirection = 'put anomaly';
    } else {
      leadDirection = 'bid';
      followDirection = 'put anomaly';
    }
  } else {
    if (best.correlation >= 0) {
      leadDirection = 'bid';
      followDirection = 'call anomaly';
    } else {
      leadDirection = 'flush';
      followDirection = 'call anomaly';
    }
  }

  return `${best.ticker} ${leadDirection} → ${anomaly.ticker} ${followDirection}`;
}

// ── Orchestrator ─────────────────────────────────────────────

export interface CatalystInputs {
  anomaly: AnomalyForCatalyst;
  /** Anomaly ticker's own 1-minute spot series within the T-60 window. */
  anomalySeries: AnomalySeries;
  /** Cross-asset 1-minute spot series to correlate against the anomaly. */
  crossAssets: CrossAssetSeries[];
  /** Dark-pool prints in the window, pre-filtered per feedback_darkpool_filters. */
  darkPrints: DarkPrintRow[];
  /** Flow alerts on the anomaly ticker in the window. */
  flowAlerts: FlowAlertRow[];
  /**
   * Retained for downstream consumers / telemetry — not currently used by
   * the heuristics here but documented so callers keep passing it and
   * we can fold contextual gates in without a signature change.
   */
  contextSnapshot?: ContextSnapshot;
}

/**
 * Run the full catalyst analysis on a single anomaly.
 *
 * Pure function. Callers query DB for the inputs, pass them in,
 * receive a `Catalysts` object ready to persist as
 * `resolution_outcome.catalysts`.
 */
export function analyzeCatalysts(inputs: CatalystInputs): Catalysts {
  const { anomaly, anomalySeries, crossAssets, darkPrints, flowAlerts } =
    inputs;

  const detectMs = Date.parse(anomaly.ts);
  const startMs = detectMs - CATALYST_WINDOW_MINS * 60_000;

  // Leading-lag correlations.
  const anomalyWindow = trimToWindow(anomalySeries.samples, startMs, detectMs);
  const leadingAssets: Catalysts['leading_assets'] = [];

  for (const ca of crossAssets) {
    const caWindow = trimToWindow(ca.samples, startMs, detectMs);
    const aligned = alignReturns(caWindow, anomalyWindow);
    if (aligned == null) continue;
    // Cross-correlate cross-asset (lead candidate) → anomaly ticker.
    const xc = crossCorrelate(aligned.aRet, aligned.bRet);
    if (xc != null && Math.abs(xc.corr) >= CATALYST_CORR_THRESHOLD) {
      leadingAssets.push({
        ticker: ca.ticker,
        lag_mins: xc.lag,
        correlation: Number(xc.corr.toFixed(4)),
      });
    }
  }

  // Sort by |correlation| desc so the heuristic + consumers get the
  // most-suggestive lead asset at index 0.
  leadingAssets.sort(
    (a, b) => Math.abs(b.correlation) - Math.abs(a.correlation),
  );

  // Large dark prints inside the window.
  const largeDarkPrints = darkPrints
    .filter((d) => inWindow(d.ts, startMs, detectMs))
    .filter((d) => d.notional >= CATALYST_LARGE_DARK_NOTIONAL)
    .map((d) => ({ ticker: d.ticker, ts: d.ts, notional: d.notional }));

  // Flow alerts in window.
  const flowInWindow = flowAlerts
    .filter((f) => inWindow(f.ts, startMs, detectMs))
    .map((f) => ({ ts: f.ts, ticker: f.ticker, premium: f.premium }));

  const likelyCatalyst = buildLikelyCatalyst(anomaly, leadingAssets);

  return {
    leading_assets: leadingAssets,
    large_dark_prints: largeDarkPrints,
    flow_alerts_in_window: flowInWindow,
    likely_catalyst: likelyCatalyst,
  };
}
