/**
 * Silent-Boom score + tier system.
 *
 * Every weight in this file traces back to a stratum row in the
 * Phase 0 audit:
 *   docs/tmp/silent-boom-feature-audit-2026-05-08.md
 *
 * Methodology mirrors api/_lib/lottery-score-weights.ts:
 *   1. Stratify the historical sample by feature bucket.
 *   2. Read the bucket's lift over the global high-peak baseline.
 *   3. Weight ≈ round(meaningful * (lift - 1) * scale), with the
 *      scale picked so the strongest segmenter (DTE) maxes near
 *      half the Tier-1 threshold.
 *
 * Tier thresholds are calibrated post-launch by running the score
 * on the historical sample and picking cuts that land Tier 1 ≈ 5%
 * of fires and Tier 2 ≈ 30% (matches lottery's distribution).
 *
 * Spec: docs/superpowers/specs/silent-boom-scoring-2026-05-08.md
 */

export type SilentBoomScoreTier = 'tier1' | 'tier2' | 'tier3';

// ============================================================
// Feature weights
// ============================================================

/** Days-to-expiry — by far the strongest single segmenter (3.03×
 * lift on 0DTE, 0.11× on 30D+, 46.5pp spread). */
const DTE_WEIGHTS: ReadonlyArray<readonly [maxDte: number, points: number]> = [
  [0, 10], //   0DTE → +10  (48.2% high-peak, lift 3.03×)
  [3, 4], //  1–3D → +4   (23.5%, lift 1.47×)
  [7, 0], //  4–7D → 0    (13.9%, lift 0.88×)
  [30, -3], // 8–30D → -3  (7.1%, lift 0.44×)
] as const;

/** 30D+ tail — the worst possible bucket (1.8% high-peak). */
const DTE_30D_PLUS_PENALTY = -8;

/** Baseline median volume — counter-intuitive segmenter where DEEPER
 * silence is WORSE because it correlates with ghost prints on dead
 * chains. Moderate baselines mean the chain has real life. */
const BASELINE_WEIGHTS: ReadonlyArray<
  readonly [maxBaseline: number, points: number]
> = [
  [50, -1], //   <50 → -1   (11.8% high-peak, lift 0.74×)
  [200, 3], //  50–200 → +3 (25.8%, lift 1.62×)
  [500, 5], // 200–500 → +5 (37.1%, lift 2.33×)
] as const;

/** Spike ratio — also inverts intuition: 100×+ is mostly ghost prints
 * on dead chains. The detector floor is 5×; the moderate-spike
 * bucket actually carries the strongest signal. */
const SPIKE_RATIO_WEIGHTS: ReadonlyArray<
  readonly [maxRatio: number, points: number]
> = [
  [10, 5], //   5–10× → +5   (33.6% high-peak, lift 2.11×)
  [25, 3], //  10–25× → +3   (27.7%, lift 1.74×)
  [50, 1], //  25–50× → +1   (22.3%, lift 1.40×)
  [100, 0], // 50–100× → 0   (18.7%, lift 1.17×)
] as const;

/** 100×+ spike ratio — penalty bucket (10.3% high-peak, lift 0.64×). */
const SPIKE_RATIO_HUGE_PENALTY = -3;

/** Entry price — cheap-option asymmetry (small absolute moves
 * compound to large %). Mirrors the lottery price-threshold weights. */
const PRICE_WEIGHTS: ReadonlyArray<
  readonly [maxPrice: number, points: number]
> = [
  [0.5, 5], //   <$0.50 → +5  (26.1% high-peak, lift 1.64×)
  [1.0, 0], //  $0.50–1 → 0   (13.1%, lift 0.83×)
  [5.0, -2], // $1–5     → -2 (10.1%, lift 0.64×)
] as const;

/** $5+ entry — penalty (4.0% high-peak, lift 0.25×). */
const PRICE_EXPENSIVE_PENALTY = -5;

/** Time of day, CT minute-of-day boundaries. AM_open dominates. */
export type SilentBoomTod = 'AM_open' | 'MID' | 'LUNCH' | 'PM' | 'LATE';

const TOD_WEIGHTS: Readonly<Record<SilentBoomTod, number>> = {
  AM_open: 5, // 08:30–10:00 → 26.3% high-peak, lift 1.65×
  MID: 1, // 10:00–12:00 → 17.3%, lift 1.09×
  LUNCH: 0, // 12:00–13:00 → 15.7%, lift 0.99×
  PM: -3, // 13:00–15:00 → 7.9%, lift 0.50×
  LATE: -3, // 15:00+      → 8.1%, lift 0.51×
} as const;

/** Ask% — modest segmenter; lower ask% (0.70–0.85) actually beats
 * the 0.95+ cap-blocks. */
const ASK_PCT_WEIGHTS: ReadonlyArray<
  readonly [maxAskPct: number, points: number]
> = [
  [0.85, 2], // 0.70–0.85 → +2 (22.8% high-peak, lift 1.43×)
  [0.95, 1], // 0.85–0.95 → +1 (20.5%, lift 1.29×)
] as const;

/** 0.95+ ask% — slight penalty (0.87× lift). */
const ASK_PCT_CAP_PENALTY = -1;

/** Option type — small but consistent C edge (1.06× vs 0.93×). */
const CALL_BONUS = 1;

/**
 * Tier thresholds. Calibrated against the 14,100-row historical
 * sample (2026-04-13 → 2026-05-07):
 *
 *   tier1 (score ≥ 21): 5.1% of fires, 55.7% high-peak, lift 3.50×,
 *                       mean peak +186.3%
 *   tier2 (score ≥  8): 18.7% of fires, 36.9% high-peak, lift 2.32×,
 *                       mean peak  +66.8%
 *   tier3 (score <  8): 76.2% of fires,  8.1% high-peak, lift 0.51×,
 *                       mean peak  +17.6%
 *
 * Scoring range observed: −21 to +33; mean 0.0; p95 21; p99 27.
 * The empirical calibration lives in scripts/silent_boom_feature_audit.py
 * (Phase 0). A score of +21 typically requires DTE ≤ 3 + AM_open
 * + entry < $0.50 + a moderate spike ratio.
 */
export const SILENT_BOOM_TIER_THRESHOLDS = Object.freeze({
  tier1MinScore: 21,
  tier2MinScore: 8,
} as const);

export function silentBoomScoreTier(score: number | null): SilentBoomScoreTier {
  if (score == null) return 'tier3';
  if (score >= SILENT_BOOM_TIER_THRESHOLDS.tier1MinScore) return 'tier1';
  if (score >= SILENT_BOOM_TIER_THRESHOLDS.tier2MinScore) return 'tier2';
  return 'tier3';
}

// ============================================================
// Core score function
// ============================================================

export interface SilentBoomScoreInput {
  /** Days-to-expiry (0 = same-day). */
  dte: number;
  /** Median size in the prior baseline window. */
  baselineVolume: number;
  /** Spike-bucket size / baseline median (always ≥ detector min 5). */
  spikeRatio: number;
  /** Entry price = vwap of spike bucket (or last-price fallback). */
  entryPrice: number;
  /** ask_size / (ask_size + bid_size) in the spike bucket. */
  askPct: number;
  /** Time-of-day bucket (CT). Caller derives from bucket_ct. */
  tod: SilentBoomTod;
  /** Option type. */
  optionType: 'C' | 'P';
}

/**
 * Bucket a CT minute-of-day into one of the five TOD labels. Open is
 * 08:30 CT (510); close is 15:00 (900). 15:00+ rolls into LATE for
 * SPX-style 0DTE tail prints.
 */
export function silentBoomTodFromMinuteCt(
  minuteOfDayCt: number,
): SilentBoomTod {
  if (minuteOfDayCt < 10 * 60) return 'AM_open';
  if (minuteOfDayCt < 12 * 60) return 'MID';
  if (minuteOfDayCt < 13 * 60) return 'LUNCH';
  if (minuteOfDayCt < 15 * 60) return 'PM';
  return 'LATE';
}

/**
 * Compute the integer score. Pure — same input always produces the
 * same output. Caller decides how to handle missing fields (most are
 * always present on a SilentBoomFire; tod is derived from bucket_ct).
 */
export function computeSilentBoomScore(args: SilentBoomScoreInput): number {
  let score = 0;

  // DTE
  let dteScored = false;
  for (const [maxDte, points] of DTE_WEIGHTS) {
    if (args.dte <= maxDte) {
      score += points;
      dteScored = true;
      break;
    }
  }
  if (!dteScored) score += DTE_30D_PLUS_PENALTY;

  // Baseline volume
  let baselineScored = false;
  for (const [maxBaseline, points] of BASELINE_WEIGHTS) {
    if (args.baselineVolume <= maxBaseline) {
      score += points;
      baselineScored = true;
      break;
    }
  }
  // Anything above 500 is filtered by the detector itself
  // (baselineMedianMax). Defensive default 0.
  if (!baselineScored) score += 0;

  // Spike ratio
  let ratioScored = false;
  for (const [maxRatio, points] of SPIKE_RATIO_WEIGHTS) {
    if (args.spikeRatio <= maxRatio) {
      score += points;
      ratioScored = true;
      break;
    }
  }
  if (!ratioScored) score += SPIKE_RATIO_HUGE_PENALTY;

  // Entry price
  let priceScored = false;
  for (const [maxPrice, points] of PRICE_WEIGHTS) {
    if (args.entryPrice <= maxPrice) {
      score += points;
      priceScored = true;
      break;
    }
  }
  if (!priceScored) score += PRICE_EXPENSIVE_PENALTY;

  // TOD
  score += TOD_WEIGHTS[args.tod];

  // Ask%
  let askScored = false;
  for (const [maxAsk, points] of ASK_PCT_WEIGHTS) {
    if (args.askPct < maxAsk) {
      score += points;
      askScored = true;
      break;
    }
  }
  if (!askScored) score += ASK_PCT_CAP_PENALTY;

  // Call bonus
  if (args.optionType === 'C') score += CALL_BONUS;

  return score;
}
