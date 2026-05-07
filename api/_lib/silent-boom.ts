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
  /** Max OI snapshot seen during the bucket (or earlier on this chain). */
  maxOi: number;
  /** Volume-weighted average price for the bucket. */
  vwap: number;
  /** Last trade price in the bucket (fallback when vwap is null). */
  lastPrice: number;
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
