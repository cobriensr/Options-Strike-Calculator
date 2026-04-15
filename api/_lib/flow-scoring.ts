/**
 * Pure scoring library for the Options Flow Ranking feature.
 *
 * Inputs: raw rows from the `flow_alerts` table (0-1 DTE SPXW repeated-hit
 * alerts, populated by the per-minute cron).
 *
 * Outputs:
 *   - `RankedStrike[]`: per-strike aggregates with a composite score.
 *   - `DirectionalRollup`: bullish/bearish tally based on OTM calls vs puts.
 *
 * No DB access, no network, no `Date.now()`. All functions are deterministic.
 */

import type { RankedStrike, DirectionalRollup } from '../../src/types/flow.js';

// Re-export so existing consumers (api/options-flow/top-strikes.ts) keep
// working without chasing the type to its new home.
export type { RankedStrike, DirectionalRollup };

// --- Input ------------------------------------------------------------------

export interface FlowAlertRow {
  alert_rule:
    | 'RepeatedHits'
    | 'RepeatedHitsAscendingFill'
    | 'RepeatedHitsDescendingFill';
  ticker: string;
  strike: number;
  expiry: string;
  type: 'call' | 'put';
  option_chain: string;
  created_at: string;
  price: number | null;
  underlying_price: number | null;
  total_premium: number;
  total_ask_side_prem: number | null;
  total_bid_side_prem: number | null;
  total_size: number | null;
  volume: number | null;
  open_interest: number | null;
  volume_oi_ratio: number | null;
  has_sweep: boolean | null;
  has_floor: boolean | null;
  has_multileg: boolean | null;
  has_singleleg: boolean | null;
  all_opening_trades: boolean | null;
  ask_side_ratio: number | null;
  net_premium: number | null;
  distance_from_spot: number | null;
  distance_pct: number | null;
  is_itm: boolean | null;
  minute_of_day: number | null;
}

// --- Aggregated intermediate shape -----------------------------------------

export interface Aggregated {
  strike: number;
  type: 'call' | 'put';
  total_premium: number;
  /** Premium-weighted mean of `ask_side_ratio` across rows. Null when every row was null. */
  ask_side_ratio: number | null;
  /** Max `volume_oi_ratio` across rows. Null when every row was null. */
  volume_oi_ratio: number | null;
  hit_count: number;
  has_ascending_fill: boolean;
  has_descending_fill: boolean;
  has_multileg: boolean;
  /** From the latest-seen row (spot drifts within the window, but not much). */
  distance_from_spot: number | null;
  distance_pct: number | null;
  is_itm: boolean | null;
  first_seen_at: string;
  last_seen_at: string;
}

// --- Output -----------------------------------------------------------------
//
// `RankedStrike` and `DirectionalRollup` are defined in src/types/flow.ts
// (shared with the frontend hook) and re-exported at the top of this file.

// --- Tunables ---------------------------------------------------------------

export const SCORING_WEIGHTS = {
  PREMIUM_LOG_WEIGHT: 20,
  ASK_SIDE_RATIO_WEIGHT: 30,
  VOL_OI_RATIO_WEIGHT: 15,
  VOL_OI_RATIO_CAP: 2.0,
  HIT_COUNT_WEIGHT: 10,
  ASCENDING_FILL_BONUS: 15,
  PROXIMITY_PENALTY_MAX: 20,
  PROXIMITY_PENALTY_THRESHOLD_PCT: 0.03,
  CONFIDENCE_RATIO_THRESHOLD: 1.5,
} as const;

// --- Helpers ----------------------------------------------------------------

function strikeKey(row: Pick<FlowAlertRow, 'type' | 'strike'>): string {
  return `${row.type}:${row.strike}`;
}

function isoMin(a: string, b: string): string {
  return a < b ? a : b;
}

function isoMax(a: string, b: string): string {
  return a > b ? a : b;
}

// --- Aggregation ------------------------------------------------------------

/**
 * Group alerts by `${type}:${strike}`. For each group produce a rollup with
 * premium-weighted ask-side ratio, max volume/OI ratio, and flag unions.
 */
export function aggregateAlertsByStrike(
  alerts: FlowAlertRow[],
): Map<string, Aggregated> {
  const out = new Map<string, Aggregated>();

  // Accumulators keyed alongside the partial aggregate so we can finalize
  // the premium-weighted mean at the end without a second pass.
  interface Accumulator {
    agg: Aggregated;
    askWeightedSum: number; // sum of premium * ask_side_ratio (non-null rows only)
    askWeightTotal: number; // sum of premium (non-null rows only)
    askSawValue: boolean;
    volOiSawValue: boolean;
    latestSeen: string;
  }

  const accs = new Map<string, Accumulator>();

  for (const row of alerts) {
    const key = strikeKey(row);
    let acc = accs.get(key);

    if (!acc) {
      acc = {
        agg: {
          strike: row.strike,
          type: row.type,
          total_premium: 0,
          ask_side_ratio: null,
          volume_oi_ratio: null,
          hit_count: 0,
          has_ascending_fill: false,
          has_descending_fill: false,
          has_multileg: false,
          distance_from_spot: row.distance_from_spot,
          distance_pct: row.distance_pct,
          is_itm: row.is_itm,
          first_seen_at: row.created_at,
          last_seen_at: row.created_at,
        },
        askWeightedSum: 0,
        askWeightTotal: 0,
        askSawValue: false,
        volOiSawValue: false,
        latestSeen: row.created_at,
      };
      accs.set(key, acc);
    }

    const { agg } = acc;
    agg.total_premium += row.total_premium;
    agg.hit_count += 1;

    if (row.alert_rule === 'RepeatedHitsAscendingFill') {
      agg.has_ascending_fill = true;
    }
    if (row.alert_rule === 'RepeatedHitsDescendingFill') {
      agg.has_descending_fill = true;
    }
    if (row.has_multileg === true) {
      agg.has_multileg = true;
    }

    // Premium-weighted ask_side_ratio accumulation (skip null rows).
    if (row.ask_side_ratio !== null && row.ask_side_ratio !== undefined) {
      acc.askWeightedSum += row.total_premium * row.ask_side_ratio;
      acc.askWeightTotal += row.total_premium;
      acc.askSawValue = true;
    }

    // Max volume_oi_ratio (skip null rows).
    if (row.volume_oi_ratio !== null && row.volume_oi_ratio !== undefined) {
      if (
        !acc.volOiSawValue ||
        row.volume_oi_ratio > (agg.volume_oi_ratio ?? -Infinity)
      ) {
        agg.volume_oi_ratio = row.volume_oi_ratio;
      }
      acc.volOiSawValue = true;
    }

    agg.first_seen_at = isoMin(agg.first_seen_at, row.created_at);
    agg.last_seen_at = isoMax(agg.last_seen_at, row.created_at);

    // Track latest-seen distance/itm fields — they drift with spot but stay
    // close within a window.
    if (row.created_at >= acc.latestSeen) {
      acc.latestSeen = row.created_at;
      agg.distance_from_spot = row.distance_from_spot;
      agg.distance_pct = row.distance_pct;
      agg.is_itm = row.is_itm;
    }
  }

  for (const [key, acc] of accs) {
    if (acc.askSawValue && acc.askWeightTotal > 0) {
      acc.agg.ask_side_ratio = acc.askWeightedSum / acc.askWeightTotal;
    } else {
      acc.agg.ask_side_ratio = null;
    }
    out.set(key, acc.agg);
  }

  return out;
}

// --- Scoring ----------------------------------------------------------------

export function proximityPenalty(distancePct: number | null): number {
  if (distancePct === null || distancePct === undefined) {
    return 0;
  }
  const d = Math.abs(distancePct);
  if (d <= 0) return 0;

  const { PROXIMITY_PENALTY_THRESHOLD_PCT, PROXIMITY_PENALTY_MAX } =
    SCORING_WEIGHTS;

  if (d >= PROXIMITY_PENALTY_THRESHOLD_PCT) return PROXIMITY_PENALTY_MAX;
  return (d / PROXIMITY_PENALTY_THRESHOLD_PCT) * PROXIMITY_PENALTY_MAX;
}

export function scoreStrike(agg: Aggregated): number {
  const {
    PREMIUM_LOG_WEIGHT,
    ASK_SIDE_RATIO_WEIGHT,
    VOL_OI_RATIO_WEIGHT,
    VOL_OI_RATIO_CAP,
    HIT_COUNT_WEIGHT,
    ASCENDING_FILL_BONUS,
  } = SCORING_WEIGHTS;

  const premiumTerm =
    Math.log10(Math.max(1, agg.total_premium)) * PREMIUM_LOG_WEIGHT;
  const askSideTerm = (agg.ask_side_ratio ?? 0) * ASK_SIDE_RATIO_WEIGHT;
  const volOiTerm =
    Math.min(agg.volume_oi_ratio ?? 0, VOL_OI_RATIO_CAP) * VOL_OI_RATIO_WEIGHT;
  const hitTerm = agg.hit_count * HIT_COUNT_WEIGHT;
  const ascBonus = agg.has_ascending_fill ? ASCENDING_FILL_BONUS : 0;
  const penalty = proximityPenalty(agg.distance_pct);

  return premiumTerm + askSideTerm + volOiTerm + hitTerm + ascBonus - penalty;
}

// --- Ranking ----------------------------------------------------------------

export function rankStrikes(
  alerts: FlowAlertRow[],
  limit: number,
): RankedStrike[] {
  const aggregates = aggregateAlertsByStrike(alerts);

  const ranked: RankedStrike[] = [];
  for (const agg of aggregates.values()) {
    ranked.push({
      strike: agg.strike,
      type: agg.type,
      distance_from_spot: agg.distance_from_spot ?? 0,
      distance_pct: agg.distance_pct ?? 0,
      total_premium: agg.total_premium,
      ask_side_ratio: agg.ask_side_ratio ?? 0,
      volume_oi_ratio: agg.volume_oi_ratio ?? 0,
      hit_count: agg.hit_count,
      has_ascending_fill: agg.has_ascending_fill,
      has_descending_fill: agg.has_descending_fill,
      has_multileg: agg.has_multileg,
      is_itm: agg.is_itm ?? false,
      score: scoreStrike(agg),
      first_seen_at: agg.first_seen_at,
      last_seen_at: agg.last_seen_at,
    });
  }

  ranked.sort((a, b) => b.score - a.score);
  if (limit < 0) return [];
  return ranked.slice(0, limit);
}

// --- Directional rollup -----------------------------------------------------

export function computeDirectionalRollup(
  ranked: RankedStrike[],
  spot: number | null,
): DirectionalRollup {
  const empty: DirectionalRollup = {
    bullish_count: 0,
    bearish_count: 0,
    bullish_premium: 0,
    bearish_premium: 0,
    lean: 'neutral',
    confidence: 0,
    top_bullish_strike: null,
    top_bearish_strike: null,
  };

  if (spot === null || spot === undefined) {
    return empty;
  }

  let bullishCount = 0;
  let bearishCount = 0;
  let bullishPremium = 0;
  let bearishPremium = 0;
  let topBullish: { strike: number; premium: number } | null = null;
  let topBearish: { strike: number; premium: number } | null = null;

  for (const r of ranked) {
    const isOtmCall = r.type === 'call' && r.strike > spot;
    const isOtmPut = r.type === 'put' && r.strike < spot;

    if (isOtmCall) {
      bullishCount += 1;
      bullishPremium += r.total_premium;
      if (topBullish === null || r.total_premium > topBullish.premium) {
        topBullish = { strike: r.strike, premium: r.total_premium };
      }
    } else if (isOtmPut) {
      bearishCount += 1;
      bearishPremium += r.total_premium;
      if (topBearish === null || r.total_premium > topBearish.premium) {
        topBearish = { strike: r.strike, premium: r.total_premium };
      }
    }
    // ITM calls/puts are neutral — skipped intentionally.
  }

  const { CONFIDENCE_RATIO_THRESHOLD } = SCORING_WEIGHTS;

  let lean: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  if (bullishPremium === 0 && bearishPremium === 0) {
    // Already neutral — explicit branch for readability; no reassignment
    // needed (sonarjs flags it as redundant).
  } else if (bullishPremium > CONFIDENCE_RATIO_THRESHOLD * bearishPremium) {
    lean = 'bullish';
  } else if (bearishPremium > CONFIDENCE_RATIO_THRESHOLD * bullishPremium) {
    lean = 'bearish';
  }

  let confidence = 0;
  if (lean === 'bullish') {
    const dominant = bullishPremium;
    const subordinate = bearishPremium;
    confidence = Math.min(1, (dominant - subordinate) / Math.max(1, dominant));
  } else if (lean === 'bearish') {
    const dominant = bearishPremium;
    const subordinate = bullishPremium;
    confidence = Math.min(1, (dominant - subordinate) / Math.max(1, dominant));
  }

  return {
    bullish_count: bullishCount,
    bearish_count: bearishCount,
    bullish_premium: bullishPremium,
    bearish_premium: bearishPremium,
    lean,
    confidence,
    top_bullish_strike: topBullish?.strike ?? null,
    top_bearish_strike: topBearish?.strike ?? null,
  };
}
