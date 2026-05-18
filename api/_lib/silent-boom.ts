/**
 * Silent → Boom alert detector — pure TS port of
 * scripts/silent_boom_audit.py.
 *
 * Pattern: a chain has been quiet across its prior 4 *traded* 5-min
 * buckets (regardless of wall-clock gaps between them — sparse chains
 * may span hours), then a single 5-min bucket shows a volume spike
 * that's both absolutely large (≥ MIN_SPIKE_VOL) and a multiple of its
 * own baseline (≥ SPIKE_MULTIPLIER × baseline median), heavily
 * ask-side (≥ ASK_PCT_MIN), with meaningful vol/OI of the spike alone
 * (≥ VOL_OI_MIN).
 *
 * This is a STEP-CHANGE ANOMALY DETECTOR — distinct from
 * lottery_finder.ts which detects cumulative-burst patterns. The two
 * complement each other; they should not share parameters.
 *
 * Spec: docs/superpowers/specs/silent-boom-detector-2026-05-08.md
 * Empirical audit: docs/tmp/silent-boom-audit-2026-05-07.md
 */

// ============================================================
// Spec constants — frozen against the 19-day audit window.
// Changing these silently changes the alert universe; treat as
// load-bearing. Kept in lockstep with silent_boom_audit.py.
// ============================================================
export const SILENT_BOOM_SPEC_V1 = Object.freeze({
  /** Number of prior traded 5-min buckets in the baseline window. */
  baselineBuckets: 4,
  /** Baseline median volume must be ≤ this to qualify as "silent". */
  baselineMedianMax: 500,
  /** Absolute volume floor for the spike bucket. */
  minSpikeVol: 1_000,
  /** Spike volume must be ≥ this multiple of baseline median. */
  spikeMultiplier: 5.0,
  /** Ask-side fraction in the spike bucket. */
  askPctMin: 0.7,
  /** Spike volume / max OI seen for chain. */
  volOiMin: 0.25,
  /** Wall-clock minutes between successive fires on the same chain
   *  (12 buckets × 5 min = 60 min of real time). The cooldown gate is
   *  time-based, not bucket-index-based — see detector for details. */
  cooldownBuckets: 12,
  /** Minimum OI for the chain to be considered. */
  minOi: 100,
  /** Max multi-leg size share of the spike bucket. Buckets at or above
   *  this threshold are rejected — they're dominated by spread-leg
   *  routing (mlat/mlet/etc. trade codes) and carry no directional
   *  thesis.
   *
   *  Threshold relaxed from 0.5 → 0.7 on 2026-05-16 after the EDA
   *  rerun (ml/findings/eda-rerun-2026-05-16/) showed the 50-70%
   *  bucket (N=89) preserves meaningful signal: mean peak 42.0%,
   *  median 18.0%, 11.2% hit ≥100% peak, with 1.41× win50 lift vs
   *  baseline. The 70-100% bucket (N=4,545) is the actual cliff:
   *  mean 23.7%, median 6.3%, 0.64× win50 lift. The original 0.5
   *  cut was conservative; 0.7 is where the data says dealer-hedge
   *  dominance actually starts.
   *
   *  Note on legacy data: silent_boom_alerts contains ~4,634 rows
   *  with multi_leg_share ≥ 0.50 spanning 2026-05-07 → 2026-05-12.
   *  These predate the original 0.5 gate landing in commit 77d3b3ad
   *  (Tue May 12 23:03 CT) — they are NOT a sign that the gate
   *  leaks. Every row inserted after the gate respects the live
   *  threshold; verified 2026-05-16 (0 rows ≥ 0.50 inserted after
   *  2026-05-13 04:30 UTC). The commit message on e4ef4ab0 mistook
   *  the legacy population for an active leak; that was wrong. The
   *  parquet backfill in f986527f only fills `WHERE multi_leg_share
   *  IS NULL`, so it cannot overwrite a fresh detector-set value.
   *
   *  Original empirical basis: scripts/analyze_silent_boom_multileg.py
   *  2026-05-12 — multi-leg fires win > 100% at 3× lower rate than
   *  single-leg in every ask% band. Specs:
   *  docs/superpowers/specs/silent-boom-ask-100-demote-2026-05-12.md
   *  docs/superpowers/specs/lottery-silentboom-eda-impl-2026-05-16.md */
  multiLegShareMax: 0.7,
} as const);

/** Bucket size in milliseconds (5 minutes). */
export const SILENT_BOOM_BUCKET_MS = 5 * 60 * 1000;

// ============================================================
// Input + output types
// ============================================================

/**
 * One pre-aggregated 5-min bucket on a single option chain. Caller
 * groups raw `ws_option_trades` rows into these (sum size, ask_size,
 * bid_size; max OI; vwap of price). Same shape Python audit produces
 * via pandas resample.
 */
export interface ChainBucket {
  /** Bucket start time (UTC, floor-of-5min). */
  bucket: Date;
  /** Total contract volume in this bucket. */
  size: number;
  /** Ask-side contracts in this bucket. */
  askSize: number;
  /** Bid-side contracts in this bucket. */
  bidSize: number;
  /** Multi-leg contracts in this bucket — sum of size whose UW
   *  trade_code is one of mlat/mlet/mlft/mfto/masl/mesl/mfsl/mlct
   *  (OPRA-standard multi-leg sale conditions). Caller aggregates
   *  from ws_option_trades.raw_payload->>'trade_code'. */
  multiLegSize: number;
  /** Max OI snapshot seen during the bucket (or earlier on this chain). */
  maxOi: number;
  /** Volume-weighted average price for the bucket. */
  vwap: number;
  /** Last trade price in the bucket (fallback when vwap is null). */
  lastPrice: number;
  /**
   * Volume-weighted underlying spot during the bucket. Optional so
   * older callers / parquet shapes that lack the underlying_price
   * column still compile; null is passed through to the fire's
   * `underlyingPriceAtSpike` for the OTM filter to gate on
   * IS NOT NULL.
   */
  underlyingVwap?: number | null;
  /**
   * Volume-weighted gamma over the bucket — extracted from
   * raw_payload->>'gamma' in ws_option_trades at SELECT time, since
   * the daemon doesn't promote gamma to a typed column. Null when no
   * tick in the bucket carried a gamma value. Empirical basis for
   * the gamma feature: docs/tmp/gamma-deep-dive-findings-2026-05-17.md
   * (+10.7pp SB winrate lift at top decile; gradient curve, not
   * stepped). Stored as gamma_at_trigger on silent_boom_alerts by
   * migration #168.
   */
  bucketGamma?: number | null;
  /**
   * H2 in-bucket cadence — fraction (0..1) of bucket size landing in
   * the first 60 seconds of the 5-min bucket. Null when bucket size
   * is 0 or no usable cadence signal. Stored as first_min_share on
   * silent_boom_alerts by migration #171. Empirical basis: 93-day
   * Pass B peak revisit (docs/tmp/sb-93d-pass-b-peak-output.txt) —
   * distributed (<25%) +3.2pp, single-block (>75%) -6.4pp lift.
   */
  firstMinShare?: number | null;
  /**
   * H5 in-bucket NBBO spread — size-weighted relative spread
   * ((ask-bid)/mid) across the bucket. Null when no print in the
   * bucket had a usable NBBO. Stored as spread_in_bucket on
   * silent_boom_alerts by migration #171. Counter-intuitive: WIDER
   * in-bucket spreads correlate with better peak outcomes (likely
   * "breakout before MM recalibration"). Q3 (>0.1122) +5.5pp lift,
   * Q0 (<0.0181) -7.6pp lift.
   */
  spreadInBucket?: number | null;
}

/** One silent-boom alert emitted by the detector. */
export interface SilentBoomFire {
  /** Bucket timestamp of the spike (UTC). */
  bucketTs: Date;
  /** Sum of sizes in the spike bucket. */
  spikeVolume: number;
  /** Median size across the trailing baseline window. */
  baselineVolume: number;
  /** spikeVolume / max(baselineVolume, 1). */
  spikeRatio: number;
  /** ask_size / (ask_size + bid_size) in the spike bucket. */
  askPct: number;
  /** spikeVolume / openInterest. */
  volOi: number;
  /** Entry price = vwap of the spike bucket. */
  entryPrice: number;
  /** Max OI seen for chain at the spike bucket. */
  openInterest: number;
  /** Fraction of spike-bucket size that came from multi-leg trades
   *  (per UW trade_code). Always < multiLegShareMax — buckets at or
   *  above the threshold were rejected before this fire was emitted. */
  multiLegShare: number;
  /** Volume-weighted underlying spot during the spike bucket. NULL
   *  on buckets where the source didn't carry underlying_price. */
  underlyingPriceAtSpike: number | null;
  /**
   * Volume-weighted gamma over the spike bucket. NULL when no tick
   * in the bucket carried a gamma value (older raw_payloads). Fed
   * straight to silent_boom_alerts.gamma_at_trigger (migration #168).
   */
  gammaAtSpike: number | null;
  /**
   * H2 cadence on the spike bucket. Fed straight to
   * silent_boom_alerts.first_min_share (migration #171). NULL when
   * the bucket has no usable cadence signal.
   */
  firstMinShareAtSpike: number | null;
  /**
   * H5 NBBO spread on the spike bucket. Fed straight to
   * silent_boom_alerts.spread_in_bucket (migration #171). NULL when
   * no print in the bucket had usable NBBO.
   */
  spreadInBucketAtSpike: number | null;
}

// ============================================================
// Detector core
// ============================================================

/**
 * Run the silent-boom detector on one chain's pre-aggregated buckets.
 *
 * Returns all qualifying fires (cooldown-filtered). Caller must pass
 * buckets in ascending bucket-time order.
 *
 * `priorLastFireMs` (optional) seeds the cooldown gate from a fire
 * that landed before the current scan window — used by the cron to
 * persist the 60-min cooldown across cron-tick boundaries. Same
 * pattern as `detectChainFires` in lottery-finder.ts.
 */
export function detectSilentBoomFires(
  buckets: readonly ChainBucket[],
  priorLastFireMs: number | null = null,
): SilentBoomFire[] {
  const {
    baselineBuckets,
    baselineMedianMax,
    minSpikeVol,
    spikeMultiplier,
    askPctMin,
    volOiMin,
    cooldownBuckets,
    minOi,
    multiLegShareMax,
  } = SILENT_BOOM_SPEC_V1;

  if (buckets.length < baselineBuckets + 1) return [];

  const cooldownMs = cooldownBuckets * SILENT_BOOM_BUCKET_MS;
  const fires: SilentBoomFire[] = [];
  let lastFireMs: number | null = priorLastFireMs;

  for (let i = baselineBuckets; i < buckets.length; i++) {
    const cur = buckets[i]!;
    const tsMs = cur.bucket.getTime();

    // Cooldown gate.
    if (lastFireMs != null && tsMs - lastFireMs < cooldownMs) continue;

    // Trailing baseline window — median size of the prior
    // `baselineBuckets` buckets.
    const sizes: number[] = [];
    for (let j = i - baselineBuckets; j < i; j++) {
      sizes.push(buckets[j]!.size);
    }
    const baseline = median(sizes);

    // Silence test.
    if (baseline > baselineMedianMax) continue;

    // Spike size — absolute floor + multiple of baseline.
    if (cur.size < minSpikeVol) continue;
    if (cur.size < spikeMultiplier * Math.max(baseline, 100)) continue;

    // Ask-side dominance.
    const ab = cur.askSize + cur.bidSize;
    if (ab === 0) continue;
    const askPct = cur.askSize / ab;
    if (askPct < askPctMin) continue;

    // OI floor + vol/OI.
    if (cur.maxOi < minOi) continue;
    const volOi = cur.size / cur.maxOi;
    if (volOi < volOiMin) continue;

    // Multi-leg drop. Spread-leg-dominated buckets carry no directional
    // thesis even when they print ask-heavy.
    const multiLegShare = cur.size > 0 ? cur.multiLegSize / cur.size : 0;
    if (multiLegShare >= multiLegShareMax) continue;

    const entry =
      Number.isFinite(cur.vwap) && cur.vwap > 0 ? cur.vwap : cur.lastPrice;
    if (entry <= 0) continue;

    fires.push({
      bucketTs: cur.bucket,
      spikeVolume: cur.size,
      baselineVolume: baseline,
      spikeRatio: cur.size / Math.max(baseline, 1),
      askPct,
      volOi,
      entryPrice: entry,
      openInterest: cur.maxOi,
      multiLegShare,
      underlyingPriceAtSpike:
        cur.underlyingVwap != null && Number.isFinite(cur.underlyingVwap)
          ? cur.underlyingVwap
          : null,
      gammaAtSpike:
        cur.bucketGamma != null && Number.isFinite(cur.bucketGamma)
          ? cur.bucketGamma
          : null,
      firstMinShareAtSpike:
        cur.firstMinShare != null && Number.isFinite(cur.firstMinShare)
          ? cur.firstMinShare
          : null,
      spreadInBucketAtSpike:
        cur.spreadInBucket != null && Number.isFinite(cur.spreadInBucket)
          ? cur.spreadInBucket
          : null,
    });
    lastFireMs = tsMs;
  }

  return fires;
}

/**
 * Median of a non-empty number array. Linear-time copy + in-place
 * sort; fine for the 4-element baseline window the detector uses.
 */
function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}
