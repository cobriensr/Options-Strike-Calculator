/**
 * Pure aggregation helpers for the per-ticker rollup header in
 * Silent Boom and Lottery Finder. Spec:
 * docs/superpowers/specs/ticker-rollup-aggregates-2026-05-15.md
 *
 * Each panel maps its native alert/fire shape into `RollupAlertSummary[]`
 * and feeds it to `computeRollupAggregates()`. The shape is intentionally
 * minimal — only the fields needed by the five chips.
 */

export interface RollupAlertSummary {
  /** 'C' for call, 'P' for put — matches the project-wide OptionType. */
  optionType: 'C' | 'P';
  /** Market Tide NCP - NPP at trigger time. Null = pre-Phase-4 row. */
  mktTideDiff: number | null;
  /** Phase 4 direction-gate flag. */
  directionGated: boolean;
  /** ISO timestamp at fire/trigger (CT-anchored or UTC; we only diff). */
  triggeredAt: string;
  strike: number;
  /**
   * Per-ticker cumulative NCP − NPP at trigger time. Null when the
   * feed lacks the fire-time snapshot (pre-#158 rows or outside-WS-
   * universe tickers). Sign-only — no deadband.
   */
  tickerNetFlowAtFire: number | null;
  /**
   * Trigger-window premium in dollars (entry price × contracts × 100).
   * Optional so older callers / shapes without size data still compile;
   * null/undefined rows simply don't contribute to `totalPremium`.
   */
  premium?: number | null;
  /**
   * Per-alert "intensity" used by the burst-storm badge — panel-
   * specific by design: SilentBoom passes spikeRatio (multiplier vs
   * 4-bucket baseline), Lottery passes fireCount (re-trigger count
   * on the chain). Each panel sets its own threshold via the
   * `intensityThreshold` arg on isBurstStorm(). Optional; rows
   * without a value contribute nothing to `maxIntensity`.
   */
  intensity?: number | null;
}

export type Bias = 'bull' | 'bear' | 'mixed';

export type TideAggregate =
  | { dir: 'up' | 'down'; align: 'aligned' | 'counter' }
  | { dir: 'mixed'; align: 'mixed' }
  | { dir: 'unknown'; align: 'unknown' };

export interface RollupAggregates {
  bias: Bias | null;
  tide: TideAggregate;
  /** Null when count < 2 (no spread to measure). */
  spreadMinutes: number | null;
  gatedCount: number;
  /**
   * Min/max strike across distinct strike values (a 68C and a 68P count
   * once at 68 — chain anchor matters more than side for concentration).
   * Null when fewer than 2 distinct strikes.
   */
  strikeRange: { min: number; max: number; spreadPts: number } | null;
  /**
   * Sum of `premium` across rows where it was provided. Null when no
   * row contributed (every row had a null/undefined premium).
   */
  totalPremium: number | null;
  /**
   * Max `intensity` across rows where it was provided. Null when no
   * row contributed. Used by the burst-storm badge — interpretation
   * (spike-ratio vs fire-count etc.) is panel-specific.
   */
  maxIntensity: number | null;
  /** Per-ticker net flow direction aggregation. Same shape as `tide`. */
  flow: TideAggregate;
}

export function computeRollupAggregates(
  rows: readonly RollupAlertSummary[],
): RollupAggregates {
  if (rows.length === 0) {
    return {
      bias: null,
      tide: { dir: 'unknown', align: 'unknown' },
      flow: { dir: 'unknown', align: 'unknown' },
      spreadMinutes: null,
      gatedCount: 0,
      strikeRange: null,
      totalPremium: null,
      maxIntensity: null,
    };
  }

  const bias = computeBias(rows);
  const tide = computeTide(rows, bias);
  const flow = computeFlow(rows, bias);
  const spreadMinutes = computeSpreadMinutes(rows);
  const gatedCount = rows.reduce((n, r) => n + (r.directionGated ? 1 : 0), 0);
  const strikeRange = computeStrikeRange(rows);
  const totalPremium = computeTotalPremium(rows);
  const maxIntensity = computeMaxIntensity(rows);

  return {
    bias,
    tide,
    flow,
    spreadMinutes,
    gatedCount,
    strikeRange,
    totalPremium,
    maxIntensity,
  };
}

function computeMaxIntensity(
  rows: readonly RollupAlertSummary[],
): number | null {
  let max = Number.NEGATIVE_INFINITY;
  let contributed = false;
  for (const r of rows) {
    if (r.intensity == null || !Number.isFinite(r.intensity)) continue;
    if (r.intensity > max) max = r.intensity;
    contributed = true;
  }
  return contributed ? max : null;
}

function computeTotalPremium(
  rows: readonly RollupAlertSummary[],
): number | null {
  let sum = 0;
  let contributed = false;
  for (const r of rows) {
    if (r.premium == null || !Number.isFinite(r.premium)) continue;
    sum += r.premium;
    contributed = true;
  }
  return contributed ? sum : null;
}

function computeBias(rows: readonly RollupAlertSummary[]): Bias {
  let calls = 0;
  let puts = 0;
  for (const r of rows) {
    if (r.optionType === 'C') calls += 1;
    else puts += 1;
  }
  if (calls > 0 && puts === 0) return 'bull';
  if (puts > 0 && calls === 0) return 'bear';
  return 'mixed';
}

function computeDirAlignment(
  rows: readonly RollupAlertSummary[],
  bias: Bias,
  selector: (r: RollupAlertSummary) => number | null,
): TideAggregate {
  let pos = 0;
  let neg = 0;
  let nonNull = 0;
  for (const r of rows) {
    const v = selector(r);
    if (v == null) continue;
    nonNull += 1;
    if (v > 0) pos += 1;
    else if (v < 0) neg += 1;
  }
  if (nonNull === 0) return { dir: 'unknown', align: 'unknown' };

  let dir: 'up' | 'down' | 'mixed';
  if (pos > 0 && neg === 0) dir = 'up';
  else if (neg > 0 && pos === 0) dir = 'down';
  else dir = 'mixed';

  if (dir === 'mixed' || bias === 'mixed') {
    return { dir: 'mixed', align: 'mixed' };
  }
  const aligned =
    (bias === 'bull' && dir === 'up') || (bias === 'bear' && dir === 'down');
  return { dir, align: aligned ? 'aligned' : 'counter' };
}

function computeTide(
  rows: readonly RollupAlertSummary[],
  bias: Bias,
): TideAggregate {
  return computeDirAlignment(rows, bias, (r) => r.mktTideDiff);
}

function computeFlow(
  rows: readonly RollupAlertSummary[],
  bias: Bias,
): TideAggregate {
  return computeDirAlignment(rows, bias, (r) => r.tickerNetFlowAtFire);
}

function computeSpreadMinutes(
  rows: readonly RollupAlertSummary[],
): number | null {
  if (rows.length < 2) return null;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const r of rows) {
    const t = Date.parse(r.triggeredAt);
    if (!Number.isFinite(t)) continue;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) {
    return null;
  }
  return Math.round((max - min) / 60_000);
}

function computeStrikeRange(
  rows: readonly RollupAlertSummary[],
): RollupAggregates['strikeRange'] {
  const distinct = new Set<number>();
  for (const r of rows) distinct.add(r.strike);
  if (distinct.size < 2) return null;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const s of distinct) {
    if (s < min) min = s;
    if (s > max) max = s;
  }
  return { min, max, spreadPts: max - min };
}

/** Format `spreadMinutes` for display — `Δ 8min` or `Δ 2.5h`. */
export function formatSpreadDuration(minutes: number): string {
  if (minutes <= 60) return `Δ ${minutes}min`;
  return `Δ ${(minutes / 60).toFixed(1)}h`;
}

/** Render bias chip text. */
export function formatBiasLabel(bias: Bias): string {
  if (bias === 'bull') return '↑ bull';
  if (bias === 'bear') return '↓ bear';
  return '~ mixed';
}

/** Render tide chip text. */
export function formatTideLabel(tide: TideAggregate): string {
  if (tide.dir === 'unknown') return 'tide —';
  if (tide.dir === 'mixed') return 'tide mixed';
  const arrow = tide.dir === 'up' ? '↑' : '↓';
  return `tide ${arrow} ${tide.align}`;
}

/** Render flow chip text. Mirror of `formatTideLabel`. */
export function formatFlowLabel(flow: TideAggregate): string {
  if (flow.dir === 'unknown') return 'flow —';
  if (flow.dir === 'mixed') return 'flow mixed';
  const arrow = flow.dir === 'up' ? '↑' : '↓';
  return `flow ${arrow} ${flow.align}`;
}

/**
 * Quick-succession ceiling for the high-conviction badge. Fires that
 * cluster within this window read as one informed footprint; beyond it
 * the alerts feel like separate, weakly-correlated events.
 */
export const HIGH_CONVICTION_MAX_SPREAD_MINUTES = 15;

/** Minimum fires required for the high-conviction badge. */
export const HIGH_CONVICTION_MIN_FIRES = 3;

/**
 * "Shiny" badge predicate: ≥3 fires, clean single-direction bias,
 * ≥2 distinct strikes, all clustered within the quick-succession
 * window. Tide alignment is intentionally NOT required — trader
 * judgment from the 2026-05-15 scoping is that it's not load-bearing
 * for the conviction read.
 */
export function isHighConviction(
  agg: RollupAggregates,
  fireCount: number,
): boolean {
  if (fireCount < HIGH_CONVICTION_MIN_FIRES) return false;
  if (agg.bias === null || agg.bias === 'mixed') return false;
  if (agg.strikeRange === null) return false;
  if (agg.spreadMinutes === null) return false;
  return agg.spreadMinutes <= HIGH_CONVICTION_MAX_SPREAD_MINUTES;
}

/** Display label for the high-conviction badge chip. */
export const HIGH_CONVICTION_BADGE_LABEL = '✦ conviction';

// ============================================================
// Burst-storm badge — the "LOOK AT ME" tier.
// ============================================================
//
// Distinct from the conviction badge: fires for *loud* setups even
// when bias/tide are messy. Trader-spec 2026-05-15 from MSFT 9-alert
// (tide counter, max spike ×221) and NVDA 18-fire (mixed bias, max
// fireCount ×22) — both worth eyeballing despite failing every
// conviction criterion.

/** Min alerts/fires for the burst-storm badge. */
export const BURST_STORM_MIN_COUNT = 8;

/** Aggregate ticker premium floor ($USD) for the badge. */
export const BURST_STORM_MIN_PREMIUM = 500_000;

/**
 * Burst-storm predicate. Any one of three signals qualifies:
 *   1. Alert/fire count >= {@link BURST_STORM_MIN_COUNT}
 *   2. Max single-alert intensity >= caller-supplied threshold
 *      (panel-specific: SilentBoom uses spikeRatio, Lottery uses
 *      fireCount-per-chain)
 *   3. Aggregate premium >= {@link BURST_STORM_MIN_PREMIUM}
 *
 * Intentionally independent of conviction — both badges can fire on
 * the same ticker. Conviction says "clean"; storm says "loud."
 */
export function isBurstStorm(
  agg: RollupAggregates,
  fireCount: number,
  intensityThreshold: number,
): boolean {
  if (fireCount >= BURST_STORM_MIN_COUNT) return true;
  if (agg.maxIntensity != null && agg.maxIntensity >= intensityThreshold) {
    return true;
  }
  if (agg.totalPremium != null && agg.totalPremium >= BURST_STORM_MIN_PREMIUM) {
    return true;
  }
  return false;
}

/** Per-panel threshold for the {@link isBurstStorm} intensity arm. */
export const BURST_STORM_INTENSITY_THRESHOLDS = {
  /** SilentBoom spikeRatio: ×100+ is "extreme outlier" territory. */
  silentBoom: 100,
  /**
   * Lottery per-chain fireCount: ×20 re-triggers on one chain reflects
   * the kind of sticky-flow pattern NVDA showed (×22 max on 2026-05-15).
   */
  lottery: 20,
} as const;

/** Display label for the burst-storm badge chip. */
export const BURST_STORM_BADGE_LABEL = '⚡ storm';

/**
 * Compact unsigned dollar formatter for option premium amounts.
 * Mirrors the Unusual Whales chart style — "$58K" / "$2.1M" — so the
 * rollup matches what the trader sees in the source UI.
 *
 * Distinct from `LotteryRow.formatPremium` (which is signed and
 * intended for NCP/NPP deltas). Keep the name explicit to avoid the
 * two converging by accident.
 */
export function formatPremiumAmount(dollars: number): string {
  if (!Number.isFinite(dollars)) return '$—';
  const sign = dollars < 0 ? '-' : '';
  const abs = Math.abs(dollars);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${Math.round(abs / 1_000)}K`;
  return `${sign}$${Math.round(abs)}`;
}
