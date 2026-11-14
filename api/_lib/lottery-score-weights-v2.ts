/**
 * The v2 lottery scorer: a pure function of a validated weights object.
 *
 * Spec: docs/superpowers/specs/lottery-rescore-2026-05-22.md (the model)
 *       docs/superpowers/plans/2026-11-05-nightly-pipeline-phase4.md (D5, the store)
 *
 * The weights are data, not code. A version of them is one row of
 * `lottery_score_versions` in Neon (D5), parsed with `LotteryWeightsSchema`
 * before it gets here, and `scoreLotteryV2(weights, fire)` sums what the
 * object says. The first version, `seed-2026-06-17`, is the frozen constants
 * this file used to generate (`lottery-weights-seed.ts`). The deprecated
 * wrappers at the bottom score with it until the cron loads a version from the
 * store.
 */

import type { LotteryWeights, TimeOfDay } from './lottery-weights-schema.js';
import { SEED_LOTTERY_WEIGHTS } from './lottery-weights-seed.js';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface LotteryScoreInput {
  ticker: string;
  tod: TimeOfDay;
  /** Days-to-expiry; only 0, 1, 2, 3 are in the scoring universe. */
  dte: number;
  /** vol_to_oi_window at trigger time; null when not populated. */
  volOiWindow: number | null;
  /** gamma_at_trigger; null when not populated. */
  gammaAtTrigger: number | null;
  /** trigger_ask_pct; null when not populated. */
  triggerAskPct: number | null;
  optionType: 'C' | 'P';
  /**
   * True when the alert direction aligns with net flow:
   * call + cum_ncp > cum_npp, OR put + cum_npp > cum_ncp. See `isAlignedFire`.
   */
  isAligned: boolean;
  /**
   * Full day name (e.g. "Monday"; see `weekdayOf`). When provided and the
   * weights hold an override for that day, that table replaces the global tod
   * weights for this fire's tod component.
   */
  dayOfWeek?: string;
}

// ---------------------------------------------------------------------------
// Helpers shared with the detect-lottery-fires cron
// ---------------------------------------------------------------------------

/**
 * Map a continuous `value` to a quintile index (0–4) using `boundaries`.
 *
 * RIGHT-CLOSED to mirror the Python training logic exactly. Training uses
 * `pd.cut(series, bins=[-inf, b0, b1, b2, b3, inf], right=True)`, so each
 * bucket is the half-open interval `(b_{k-1}, b_k]` — a value EXACTLY ON a
 * boundary falls in the LOWER bucket. Using `value < bound` (left-closed)
 * here would skew the quintile by one for any value that lands precisely on
 * a boundary (e.g. ask_pct = ask/(ask+bid) hits exact rationals like 0.625,
 * 0.75, 0.5714…), producing a train/serve mismatch. `value <= bound` keeps
 * serve and train in lockstep.
 *
 * Assignment rules:
 *   - value <= boundaries[0] → quintile 0
 *   - value <= boundaries[1] → quintile 1
 *   - value <= boundaries[2] → quintile 2
 *   - value <= boundaries[3] → quintile 3
 *   - value >  boundaries[3] → quintile 4
 *
 * @param value      The raw feature value (e.g. vol_to_oi_window).
 * @param boundaries Four-element sorted array of bucket thresholds.
 * @returns          Integer in [0, 4].
 */
export function assignQuintile(
  value: number,
  boundaries: ReadonlyArray<number>,
): number {
  for (let i = 0; i < boundaries.length; i++) {
    const bound = boundaries[i];
    if (bound !== undefined && value <= bound) return i;
  }
  return 4;
}

/**
 * Whether a fire's direction agrees with the ticker's net flow at fire time:
 * a call needs cumulative net call premium above net put premium, a put the
 * reverse. A missing cumulative value, or a tie, is not aligned.
 */
export function isAlignedFire(
  optionType: 'C' | 'P',
  cumNcp: number | null,
  cumNpp: number | null,
): boolean {
  return (
    cumNcp != null &&
    cumNpp != null &&
    ((optionType === 'C' && cumNcp > cumNpp) ||
      (optionType === 'P' && cumNpp > cumNcp))
  );
}

/**
 * Full weekday name ("Monday") of an ISO calendar date, the way the cron has
 * always derived it: noon UTC of that date, formatted in en-US. The formatter
 * is pinned to UTC so the answer is the calendar day itself on any host; a
 * host zone ahead of UTC by 12 hours or more would otherwise read noon UTC as
 * the next day.
 */
export function weekdayOf(dateIso: string): string {
  return new Date(`${dateIso}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    timeZone: 'UTC',
  });
}

// ---------------------------------------------------------------------------
// Main score function
// ---------------------------------------------------------------------------

/**
 * Compute the v2 lottery score for a single fire alert from `weights`.
 *
 * Returns `null` when:
 *   - `args.isAligned` is false (hard gate per spec decision 6)
 *   - `args.dte` is not in {0, 1, 2, 3} (out of scoring universe)
 *
 * Otherwise returns an integer sum of per-feature weights:
 *   ticker + tod + dte + vol_oi_quintile + gamma_quintile +
 *   ask_pct_quintile + option_type + composite
 *
 * A ticker the weights do not list contributes 0. Null-safe features
 * (volOiWindow, gammaAtTrigger, triggerAskPct) contribute 0 when the value is
 * unavailable rather than invalidating the whole score.
 *
 * `dayOfWeek` (optional): full day name (see `weekdayOf`). When provided and
 * `tod_weights_dow_overrides` holds that day, the override table is used for
 * the tod component; otherwise the global `tod_weights`.
 *
 * Composite bonuses are applied last: every entry whose `match` keys all agree
 * with the fire's features contributes its `bonus` (positive = winning
 * pattern, negative = losing pattern). Multiple matches sum.
 */
export function scoreLotteryV2(
  weights: LotteryWeights,
  args: LotteryScoreInput,
): number | null {
  if (!args.isAligned) return null;

  const f = weights.features;

  const dteWeights: Readonly<Record<string, number | undefined>> =
    f.dte_weights;
  const dteWeight = dteWeights[String(args.dte)];
  if (dteWeight === undefined) return null;

  // Resolve TOD weights: use the day's override when present, else global.
  // `Object.hasOwn` keeps a day name like "constructor" off the prototype.
  const overrides: Readonly<
    Record<string, Record<TimeOfDay, number> | undefined>
  > = f.tod_weights_dow_overrides;
  const override =
    args.dayOfWeek !== undefined && Object.hasOwn(overrides, args.dayOfWeek)
      ? overrides[args.dayOfWeek]
      : undefined;
  const todWeights = override ?? f.tod_weights;

  let score = 0;

  score += f.ticker_weights[args.ticker] ?? 0;
  score += todWeights[args.tod];
  score += dteWeight;

  let volOiQ: number | null = null;
  if (args.volOiWindow !== null) {
    volOiQ = assignQuintile(args.volOiWindow, f.vol_oi_quintile_boundaries);
    score += f.vol_oi_quintile_weights[volOiQ] ?? 0;
  }

  let gammaQ: number | null = null;
  if (args.gammaAtTrigger !== null) {
    gammaQ = assignQuintile(args.gammaAtTrigger, f.gamma_quintile_boundaries);
    score += f.gamma_quintile_weights[gammaQ] ?? 0;
  }

  let askPctQ: number | null = null;
  if (args.triggerAskPct !== null) {
    askPctQ = assignQuintile(args.triggerAskPct, f.ask_pct_quintile_boundaries);
    score += f.ask_pct_quintile_weights[askPctQ] ?? 0;
  }

  score += f.option_type_weights[args.optionType];

  // Composite bonuses/penalties — iterate every entry and sum matching ones.
  for (const entry of f.composite_bonuses) {
    const m = entry.match;
    if (m.ticker !== undefined && m.ticker !== args.ticker) continue;
    if (m.tod !== undefined && m.tod !== args.tod) continue;
    if (m.gamma_q !== undefined) {
      const label = gammaQ === null ? 'null' : String(gammaQ);
      if (m.gamma_q !== label) continue;
    }
    if (m.vol_oi_q !== undefined) {
      const label = volOiQ === null ? 'null' : String(volOiQ);
      if (m.vol_oi_q !== label) continue;
    }
    if (m.ask_pct_q !== undefined) {
      const label = askPctQ === null ? 'null' : String(askPctQ);
      if (m.ask_pct_q !== label) continue;
    }
    score += entry.bonus;
  }

  return score;
}

// ---------------------------------------------------------------------------
// Tier label
// ---------------------------------------------------------------------------

/**
 * Map a v2 score to its display tier under `cutoffs` (the weights'
 * `cutoffs`, on the bare score). null score → 'tier3'.
 */
export function lotteryScoreTierV2(
  score: number | null,
  cutoffs: LotteryWeights['cutoffs'],
): 'tier1' | 'tier2' | 'tier3' {
  if (score === null) return 'tier3';
  if (score >= cutoffs.t1) return 'tier1';
  if (score >= cutoffs.t2) return 'tier2';
  return 'tier3';
}

// ---------------------------------------------------------------------------
// Deprecated: score with the frozen seed
// ---------------------------------------------------------------------------

/**
 * @deprecated Scores with the frozen seed, not the active version. Kept only
 * so `detect-lottery-fires.ts` compiles; Task 5 moves the cron onto
 * `scoreLotteryV2` with the weights loaded from the store, then deletes this.
 */
export function computeLotteryScoreV2(args: LotteryScoreInput): number | null {
  return scoreLotteryV2(SEED_LOTTERY_WEIGHTS, args);
}

/**
 * @deprecated The seed's cutoffs, not the active version's. Task 5 deletes
 * it; the cluster bonus then reads `active.weights.cutoffs.t1`.
 */
export const LOTTERY_TIER_THRESHOLDS_V2: LotteryWeights['cutoffs'] =
  SEED_LOTTERY_WEIGHTS.cutoffs;
