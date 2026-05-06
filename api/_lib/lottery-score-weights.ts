/**
 * Lottery fire score weights — derived from a rolling historical window
 * by `ml/src/lottery_scoring.py` and frozen as a TypeScript constant.
 * Source-of-truth is `ml/data/lottery_score_weights.json`; this module
 * mirrors that file inline so the cron handler doesn't touch the
 * filesystem at runtime.
 *
 * Regenerate via `make refit` (which runs the refit + this sync script
 * + a score backfill). Do NOT hand-edit — changes will be lost on the
 * next refit.
 *
 * Score formula (sum of buckets, range 0-25):
 *   ticker (0/5/7/10) + mode (0/5) + price (0/3/5) + tod (0/2/3) + option_type (0/2)
 *
 * Tier cutoffs (validated by `lottery_score_distribution.json`):
 *   Tier 1 — score ≥18 (~80% high-peak rate, ~4 fires/day)
 *   Tier 2 — 12 ≤ score < 18 (~63% high-peak rate, ~84 fires/day)
 *   Tier 3 — score < 12 (~32% high-peak rate, the remainder)
 */

import type { LotteryMode, TimeOfDay } from './lottery-finder.js';

export const LOTTERY_TICKER_WEIGHTS: Readonly<Record<string, number>> = {
  SNDK: 10,
  USO: 10,
  SLV: 10,
  SOXL: 10,
  TSLA: 10,
  TQQQ: 7,
  AMZN: 7,
  NVDA: 7,
  QQQ: 7,
  AMD: 7,
  MSFT: 5,
  GOOG: 5,
  MRVL: 5,
  GOOGL: 5,
  COIN: 5,
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
