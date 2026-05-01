/**
 * `selectTarget` — frontend-only target-selection rule that re-scores a
 * leaderboard with live price context and applies the four-gate / two-gate
 * fallback decision used by the GexTarget panel.
 *
 * Why it lives here, separate from `scoreMode`:
 *
 *   - `scoreMode` (in `pipeline.ts`) is the **offline** entry point used
 *     by the cron and backtests. It builds the universe, extracts
 *     features, and applies a 2-gate target-selection rule keyed off the
 *     stored snapshot.
 *
 *   - `selectTarget` is the **online** UI rule. It takes a leaderboard
 *     that the cron has already produced and re-scores each row with
 *     the freshest browser-side `priceCtx`, then applies a stricter
 *     4-gate primary rule with a 2-gate fallback so the visible target
 *     never lags the freshest 1-min candle by a 5-min cron cycle.
 *
 * The two rules diverge intentionally — the cron writes a stable
 * historical record, while the panel renders a live decision that
 * incorporates `priceConfirm` and an at-spot exclusion gate. Sharing the
 * function lets us unit-test the gating + scoring + tier-assignment
 * logic in isolation, without having to render the React panel.
 *
 * Pure: no React, no DOM, no fetches. Inputs are plain data, output is
 * a `TargetScore` ready for the UI to render.
 */

import {
  assignTier,
  assignWallSide,
  charmScore,
  clarity,
  computeAttractingMomentum,
  dominance,
  flowConfluence,
  priceConfirm,
  proximity,
} from './index.js';
import { GEX_TARGET_CONFIG } from './config.js';
import type {
  PriceMovementContext,
  StrikeScore,
  TargetScore,
} from './types.js';

/**
 * Component weights used by the live composite. Wider type than the
 * `as const` narrow literal on `GEX_TARGET_CONFIG.weights` so callers
 * (including tests) can pass arbitrary numeric weights without TS2322.
 */
export interface SelectTargetWeights {
  flowConfluence: number;
  priceConfirm: number;
  charmScore: number;
  clarity: number;
}

/**
 * Minimum point distance from spot for a strike to count as a
 * "forward-looking" target. At-spot strikes (`|distFromSpot| < 5`)
 * have `priceConfirm = 0` by construction and would slip past the
 * direction gate alone, so we add this gate explicitly to the primary
 * decision rule.
 */
const MIN_FORWARD_DISTANCE_PTS = 5;

/**
 * Re-score a leaderboard with the supplied weights and price context,
 * then pick the live target via a 4-gate primary rule with a 2-gate
 * fallback. Returns a fresh `TargetScore` — the input array is
 * spread-copied per row so caller-owned snapshots are never mutated.
 *
 * Primary gates (must all pass):
 *   1. Tier ≠ NONE — meaningful conviction above the noise floor.
 *   2. `attractingMomentum > 0` — wall is actively growing.
 *   3. `priceConfirm >= 0` — moving in the wall's direction (or flat).
 *   4. `|distFromSpot| >= 5` — forward-looking strike, not at-spot.
 *
 * Fallback gates (when no row passes the primary rule):
 *   - Tier ≠ NONE
 *   - `attractingMomentum > 0`
 *
 * Returns `{ target: null, leaderboard: <re-scored copy> }` when no row
 * passes either gate set — the panel renders "board churning" in that
 * case. The leaderboard is always returned in input order; downstream
 * consumers (`top5ByGex`, etc.) handle their own sorting.
 *
 * `weights` is parameterized for testability; production code passes
 * `GEX_TARGET_CONFIG.weights` from `selectTarget(leaderboard, priceCtx)`.
 */
export function selectTarget(
  leaderboard: readonly StrikeScore[],
  priceCtx: PriceMovementContext,
  weights: SelectTargetWeights = GEX_TARGET_CONFIG.weights,
): TargetScore {
  if (leaderboard.length === 0) {
    return { target: null, leaderboard: [] };
  }

  // Spread-copy every entry so we never mutate shared API response
  // objects. Reset isTarget — the live rule re-decides every render.
  const rescored: StrikeScore[] = leaderboard.map((s) => ({
    ...s,
    isTarget: false,
  }));

  // Build the peer momentum array once for the full universe so dominance
  // is computed relative to every strike, not just surviving candidates.
  const peerMomenta = rescored.map((s) =>
    computeAttractingMomentum(s.features),
  );

  for (const s of rescored) {
    const dom = dominance(s.features, peerMomenta);
    const fc = flowConfluence(s.features);
    const pc = priceConfirm(s.features, priceCtx);
    const charm = charmScore(s.features);
    const clar = clarity(s.features);
    const prox = proximity(s.features);
    const freshScore =
      weights.flowConfluence * fc * dom * prox +
      weights.priceConfirm * pc * dom * prox +
      weights.charmScore * charm * prox +
      weights.clarity * (clar - 0.5);
    s.finalScore = freshScore;
    s.tier = assignTier(freshScore);
    s.wallSide = assignWallSide(s.tier, s.features.gexDollars);
  }

  // Sort by fresh score desc and find the highest-scoring eligible target.
  // Primary: tier != NONE AND attractingMomentum > 0 AND priceConfirm >= 0
  //          AND |distFromSpot| >= 5.
  // Fallback: drop the direction + at-spot gates in flat/ambiguous markets.
  const byScore = [...rescored].sort(
    (a, b) => Math.abs(b.finalScore) - Math.abs(a.finalScore),
  );
  const topTarget =
    byScore.find(
      (s) =>
        s.tier !== 'NONE' &&
        computeAttractingMomentum(s.features) > 0 &&
        priceConfirm(s.features, priceCtx) >= 0 &&
        Math.abs(s.features.distFromSpot) >= MIN_FORWARD_DISTANCE_PTS,
    ) ??
    byScore.find(
      (s) => s.tier !== 'NONE' && computeAttractingMomentum(s.features) > 0,
    );
  if (topTarget) topTarget.isTarget = true;

  return { target: topTarget ?? null, leaderboard: rescored };
}
