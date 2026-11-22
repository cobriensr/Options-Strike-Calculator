/**
 * Legacy V1 lottery score helpers, plus the two things the feed still
 * imports from here: the `LotteryScoreTier` type and `gammaScoreAdjustment`.
 *
 * This file does not hold the live weights. The crons score with
 * `scoreLotteryV2` (`lottery-score-weights-v2.ts`) over the `active` (feed)
 * and `takeit` pointers of the weights store, which
 * `lottery-weights-loader.ts` reads. When the store can't be read the loader
 * falls back to the frozen seed, `lottery-weights-seed.ts`. A new set of
 * weights is a new version in the store, never an edit here.
 *
 * Nothing regenerates this file. It used to be synced from
 * `ml/data/lottery_score_weights.json` by a generator script during `make
 * refit`. Now `make refit` is a pair of dry runs, that script is deleted,
 * and the JSON it read no longer exists. Edit this file by hand.
 *
 * The V1 scorer below (`computeLotteryScore`, `lotteryScoreTier` and the
 * constants they read) serves no cron or endpoint. Its callers are
 * `api/__tests__/lottery-score-weights.test.ts` and, for
 * `computeLotteryScore`, two one-off scripts: `scripts/backfill-lottery-score.ts`
 * and `scripts/replay-lottery-fires-2026-05-18.ts`.
 *
 * V1 score formula (sum of buckets, range 0-25):
 *   ticker (0/5/7/10) + mode (0/5) + price (0/3/5) + tod (0/2/3) + option_type (0/2)
 *
 * V1 tier cutoffs on that score: Tier 1 ≥18, Tier 2 12-17, Tier 3 <12. The
 * feed does not use them: it tiers on qas against the active version's
 * `feed_cutoffs` (`lottery-tier.ts`).
 */

import type { LotteryMode, TimeOfDay } from './lottery-finder.js';
import {
  GAMMA_BONUS_EXCLUDED_TICKERS,
  GAMMA_HIGH_BONUS_POINTS,
  GAMMA_HIGH_BONUS_THRESHOLD,
} from './constants.js';

export const LOTTERY_TICKER_WEIGHTS: Readonly<Record<string, number>> = {
  RKLB: 10,
  SNDK: 10,
  CVNA: 10,
  AAOI: 10,
  USAR: 10,
  BA: 7,
  RDDT: 7,
  XOM: 7,
  APP: 7,
  WMT: 7,
  SNOW: 5,
  TSM: 5,
  SOUN: 5,
  DELL: 5,
  SLV: 5,
};

/** ($ entry price ≤ threshold → points). Evaluated in order; first match wins. */
export const LOTTERY_PRICE_THRESHOLDS: ReadonlyArray<
  readonly [number, number]
> = [
  [0.5, 5],
  [1.0, 3],
];

const MODE_WEIGHTS: Readonly<Record<LotteryMode, number>> = {
  A_intraday_0DTE: 5,
  B_multi_day_DTE1_3: 0,
  OUT_OF_UNIVERSE: 0,
};

const TOD_WEIGHTS: Readonly<Record<TimeOfDay, number>> = {
  AM_open: 3,
  MID: 2,
  LUNCH: 0,
  PM: 0,
};

/** Score → tier label used for badges and the peak-forecast string. */
export type LotteryScoreTier = 'tier1' | 'tier2' | 'tier3';

export const LOTTERY_TIER_THRESHOLDS = {
  tier1MinScore: 18,
  tier2MinScore: 12,
} as const;

export function lotteryScoreTier(score: number | null): LotteryScoreTier {
  if (score == null) return 'tier3';
  if (score >= LOTTERY_TIER_THRESHOLDS.tier1MinScore) return 'tier1';
  if (score >= LOTTERY_TIER_THRESHOLDS.tier2MinScore) return 'tier2';
  return 'tier3';
}

/**
 * Compute the integer score for a fire. Returns `null` when any input
 * needed to score deterministically is missing (caller should treat
 * null as Tier 3 in the UI but still surface the fire).
 */
export function computeLotteryScore(args: {
  ticker: string;
  mode: LotteryMode;
  entryPrice: number;
  tod: TimeOfDay;
  optionType: 'C' | 'P';
}): number {
  const { ticker, mode, entryPrice, tod, optionType } = args;
  let score = 0;
  score += LOTTERY_TICKER_WEIGHTS[ticker] ?? 0;
  score += MODE_WEIGHTS[mode] ?? 0;
  for (const [threshold, points] of LOTTERY_PRICE_THRESHOLDS) {
    if (entryPrice <= threshold) {
      score += points;
      break;
    }
  }
  score += TOD_WEIGHTS[tod] ?? 0;
  if (optionType === 'C') score += 2;
  return score;
}

/**
 * Gamma-at-trigger score bonus. Mirrors the SQL CASE expression baked
 * into `combined_score` by migration #168 — TS helper used by the
 * lottery-finder serializer so the per-fire `gammaScoreAdjustment`
 * field rendered on the row can be computed without re-reading
 * combined_score's component breakdown.
 *
 * Returns GAMMA_HIGH_BONUS_POINTS (=1) when:
 *   - gamma is non-null and finite AND >= GAMMA_HIGH_BONUS_THRESHOLD (0.025)
 *   - ticker is NOT in GAMMA_BONUS_EXCLUDED_TICKERS (SPY, USO)
 *
 * Empirical basis: docs/tmp/gamma-deep-dive-findings-2026-05-17.md.
 * Threshold is the LF decile-5 inflection; excluded tickers SPY/USO
 * showed -7pp/-16pp lift reversal in the same study.
 *
 * NOTE: `api/lottery-finder.ts` and
 * `api/__tests__/lottery-score-weights.test.ts` call this. `make refit` no
 * longer regenerates this file.
 */
export function gammaScoreAdjustment(
  gamma: number | null,
  ticker: string,
): number {
  if (gamma == null) return 0;
  if (!Number.isFinite(gamma)) return 0;
  if (GAMMA_BONUS_EXCLUDED_TICKERS.includes(ticker)) return 0;
  if (gamma < GAMMA_HIGH_BONUS_THRESHOLD) return 0;
  return GAMMA_HIGH_BONUS_POINTS;
}
