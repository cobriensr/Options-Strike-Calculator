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

/** Time of day, CT minute-of-day boundaries. AM_open dominates.
 *
 * Retuned 2026-05-17 against the 93-day, 63,846-alert peak dataset
 * (docs/tmp/sb-93d-peak-revisit-2026-05-17.py). Win metric is now
 * peak_ceiling_pct ≥ 50% (baseline 16.2%) rather than trail30/10 > 0.
 * Per-elapsed-bucket lift over baseline (in pp):
 *   ≤30 min:   +14.0    30–60:  +10.1    60–120: +6.5
 *   120–180:    +2.1    180–240: +0.9
 *   240–300:   -3.3     300–360: -7.4     360+: -10.8
 * AM_open straddles ≤30/30-60/60-120 → mean lift ~+10 → +6.
 * MID straddles 60-120/120-180 → mean lift ~+4 → +3.
 * PM straddles 240-300/300-360 → mean lift ~-5 → -4.
 * LATE is 360+ → lift -10.8 → -5. */
export type SilentBoomTod = 'AM_open' | 'MID' | 'LUNCH' | 'PM' | 'LATE';

const TOD_WEIGHTS: Readonly<Record<SilentBoomTod, number>> = {
  AM_open: 6, // 08:30–10:00 → mean lift +10pp on peak-≥50% metric
  MID: 3, //    10:00–12:00 → mean lift +4pp
  LUNCH: 0, //  12:00–13:00 → ~baseline
  PM: -4, //    13:00–15:00 → mean lift -5pp
  LATE: -5, //  15:00+      → lift -11pp (n=8,525)
} as const;

/** Ask% — modest segmenter; lower ask% (0.70–0.85) actually beats
 * the 0.95+ cap-blocks. */
const ASK_PCT_WEIGHTS: ReadonlyArray<
  readonly [maxAskPct: number, points: number]
> = [
  [0.85, 2], // 0.70–0.85 → +2 (22.8% high-peak, lift 1.43×)
  [0.95, 1], // 0.85–0.95 → +1 (20.5%, lift 1.29×)
] as const;

/** 0.95 ≤ ask < 1.0 — slight penalty (0.87× lift). */
const ASK_PCT_HIGH_PENALTY = -1;

/** ask_pct = 1.0 exactly — structural-illiquidity floor. Set heavy
 * enough that any otherwise-perfect score lands below the tier2 floor
 * of 8: max positive components after 2026-05-17 Phase B sum to +41
 * (10+5+5+5+6+2+1+1+4+2 — trailing +2 is adj_cofire, +4 before that
 * is pre_trade_count ≥501, +1 before that is Friday × CALL). The
 * −32 penalty caps any saturated-ask fire at +7 (+41 − 2 ask reward
 * lost − 32 penalty applied) → tier3. Penalty escalated from −30 →
 * −32 in Phase B because the new pre_trade_count + adj_cofire bonuses
 * would have pushed the worst-case saturated alert to +9, breaking
 * the tier3 invariant. Empirical basis (full 15k-fire sample,
 * scripts/analyze_silent_boom_vol_oi.py 2026-05-12): ask=1.0 fires
 * win > 0% at 77.0% vs ≥99% in every other ask band; the cliff
 * replicates inside every score_tier. Spec:
 * docs/superpowers/specs/silent-boom-ask-100-demote-2026-05-12.md */
const ASK_PCT_SATURATED_PENALTY = -32;

/** Option type — small but consistent C edge (1.06× vs 0.93×). */
const CALL_BONUS = 1;

/** Pre-trade-count bonus. Counts non-canceled trades on the same
 * option_chain_id from session open (08:30 CT) up to bucket_ct.
 * Chains that have already traded heavily (501+) outperform the
 * dead-silent baseline by +15-25pp on peak ≥50% *inside every
 * elapsed-time bucket* — i.e. the lift is independent of TOD.
 *
 * Validated against the 93-day, 63,846-alert peak dataset:
 *   0 (silent)   18.0% (n=48,511, lift +1.8pp)  → 0 (baseline)
 *   1-5           3.2% (n=3,088,  lift -13.0pp) → 0 (TOD absorbs)
 *   6-25          5.5% (n=3,775,  lift -10.7pp) → 0 (TOD absorbs)
 *   26-100        9.6% (n=3,433,  lift  -6.6pp) → 0 (TOD absorbs)
 *   101-500      13.3% (n=3,161,  lift  -2.9pp) → 0 (small)
 *   501+         28.2% (n=1,878,  lift +12.0pp) → +4 BONUS
 *
 * Only 501+ carries clean TOD-independent lift. The negative-lift
 * mid buckets (1-500) concentrate at 300+ min elapsed, where LATE/PM
 * TOD weights already penalize — scoring them again would
 * double-count. Spec:
 *   docs/superpowers/specs/silent-boom-h1-h3-features-2026-05-17.md */
const PRE_TRADE_COUNT_HEAVY_THRESHOLD = 501;
const PRE_TRADE_COUNT_HEAVY_BONUS = 4;

/** Adjacent-strike co-fire bonus. Validated against the 93-day,
 * 63,846-alert peak dataset:
 *   adj_cofire=FALSE → 16.0% peak ≥50% (n=61,935, lift -0.2pp)
 *   adj_cofire=TRUE  → 22.0% peak ≥50% (n=1,911,  lift +5.8pp)
 * Clean binary signal on a small cohort (3.0% of alerts). Intuition:
 * a real underlying move is more likely to trigger two adjacent
 * strikes simultaneously than ghost-print noise.
 *
 * Adjacent step: $1 default, $5 for SPX/NDX/RUT cash-index roots.
 * Spec:
 *   docs/superpowers/specs/silent-boom-h1-h3-features-2026-05-17.md */
const ADJ_COFIRE_BONUS = 2;

/** Day-of-week × option_type bonus. Retuned 2026-05-17 against the
 * 93-day peak dataset (n=63,846; baseline peak ≥50% = 16.2%). Three
 * cells deviate enough from baseline to score:
 *   Friday × PUT  → 19.4% (lift +3.2pp, n=7,166)  → +2
 *   Friday × CALL → 17.8% (lift +1.6pp, n=8,565)  → +1
 *   Monday × PUT  → 12.4% (lift -3.8pp, n=5,011)  → -2
 * Other combos sit within ±1.7pp of baseline and aren't scored to
 * avoid over-fitting. Friday/Monday weekend-anchor edges are
 * intuitive: Friday PMs pin into theta decay (puts capture pin-risk
 * directional moves); Monday weekend-gap-fade puts get crushed by
 * Sunday-night cold opens.
 *
 * Spec: not yet written — surgical retune on top of the original
 * scoring spec docs/superpowers/specs/silent-boom-scoring-2026-05-08.md
 */
const DOW_TYPE_BONUS: ReadonlyArray<{
  /** 0=Sun, 1=Mon, …, 5=Fri, 6=Sat (matches Date#getUTCDay output
   * when the input string is parsed as midnight UTC). */
  readonly dow: number;
  readonly optionType: 'C' | 'P';
  readonly points: number;
}> = [
  { dow: 5, optionType: 'P', points: 2 }, //   Friday × PUT
  { dow: 5, optionType: 'C', points: 1 }, //   Friday × CALL
  { dow: 1, optionType: 'P', points: -2 }, //  Monday × PUT
] as const;

/**
 * Look up the DOW × option_type bonus for a trading-day date string
 * ('YYYY-MM-DD'). The string is parsed as midnight UTC, which makes
 * `getUTCDay()` return the day-of-week of the date itself (no
 * timezone math needed — for any US-market-hours alert ET and CT
 * always agree on the calendar day). Returns 0 for unscored
 * combinations.
 */
export function silentBoomDowTypeBonus(
  tradingDay: string,
  optionType: 'C' | 'P',
): number {
  const dow = new Date(`${tradingDay}T00:00:00Z`).getUTCDay();
  for (const row of DOW_TYPE_BONUS) {
    if (row.dow === dow && row.optionType === optionType) return row.points;
  }
  return 0;
}

/**
 * Tier thresholds. Originally calibrated against the 14,100-row
 * historical sample (2026-04-13 → 2026-05-07):
 *
 *   tier1 (score ≥ 21): 5.1% of fires, 55.7% high-peak, lift 3.50×,
 *                       mean peak +186.3%
 *   tier2 (score ≥  8): 18.7% of fires, 36.9% high-peak, lift 2.32×,
 *                       mean peak  +66.8%
 *   tier3 (score <  8): 76.2% of fires,  8.1% high-peak, lift 0.51×,
 *                       mean peak  +17.6%
 *
 * Old scoring range: −21 to +33; mean 0.0; p95 21; p99 27. The
 * empirical calibration lives in scripts/silent_boom_feature_audit.py
 * (Phase 0). A score of +21 typically required DTE ≤ 3 + AM_open
 * + entry < $0.50 + a moderate spike ratio.
 *
 * 2026-05-17 retune (against 93-day, 63,846-alert peak dataset):
 * TOD weights bumped (AM_open +5→+6, MID +1→+3, PM −3→−4, LATE −3→−5)
 * and DOW × type bonus added (Fri-PUT +2, Fri-CALL +1, Mon-PUT −2).
 * Range after retune: −25 to +35. Thresholds intentionally held at
 * 21/8 so more 0DTE + AM_open alerts (which now hit +20+ before
 * baseline/ask components) flow into tier1/tier2 — that's the
 * explicit goal of the retune. Tier distribution will shift; retune
 * is logged in docs/tmp/sb-93d-peak-revisit-2026-05-17.py.
 *
 * 2026-05-17 Phase A — pre_trade_count ≥501 bonus (+4) added. New
 * range: −25 to +39.
 *
 * 2026-05-17 Phase B — adj_cofire bonus (+2) added; ask saturation
 * penalty escalated −30 → −32 to preserve the tier3 invariant. New
 * range: −25 to +41. Spec:
 *   docs/superpowers/specs/silent-boom-h1-h3-features-2026-05-17.md
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
  /** Trading-day date 'YYYY-MM-DD' (CronContext.today is ET, which
   * agrees with CT on the calendar day during US market hours). Used
   * for the DOW × type bonus (Friday × PUT, Friday × CALL, Monday ×
   * PUT). */
  tradingDay: string;
  /** Count of non-canceled trades on this option_chain_id between
   * session open (08:30 CT) and bucket_ct. Used for the heavy-prior-
   * activity bonus (+4 when ≥ 501). Pass 0 when unknown so the score
   * lands without the bonus rather than throwing — historical rows
   * predating migration #169 fall in this bucket. */
  preTradeCount: number;
  /** TRUE when another SB alert exists on the same (ticker,
   * option_type, bucket_ct) at the adjacent strike (±$1 default, ±$5
   * for SPX/NDX/RUT roots). Adds +2 to the score when TRUE. Detector
   * computes via intra-cron set lookup. Pass false when unknown
   * (legacy callers, backfill from pre-#170 data). */
  adjCofire: boolean;
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
  if (!askScored) {
    score +=
      args.askPct >= 1.0 ? ASK_PCT_SATURATED_PENALTY : ASK_PCT_HIGH_PENALTY;
  }

  // Call bonus
  if (args.optionType === 'C') score += CALL_BONUS;

  // Day-of-week × option_type bonus (Fri-PUT/Fri-CALL/Mon-PUT)
  score += silentBoomDowTypeBonus(args.tradingDay, args.optionType);

  // Pre-trade-count heavy-activity bonus (501+ trades pre-spike)
  if (args.preTradeCount >= PRE_TRADE_COUNT_HEAVY_THRESHOLD) {
    score += PRE_TRADE_COUNT_HEAVY_BONUS;
  }

  // Adjacent-strike co-fire bonus (intra-cron detection)
  if (args.adjCofire) score += ADJ_COFIRE_BONUS;

  return score;
}
