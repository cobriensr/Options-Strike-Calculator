/**
 * Precision-stack overlay for the gamma squeeze detector.
 *
 * Two pure features stamped on every fire:
 *   - hhi_neighborhood       Herfindahl of cross-strike notional in the
 *                            ±0.5% band at fire time. Lower = diffuse band
 *                            (winner archetype). Higher = concentrated whale
 *                            (often loser).
 *   - iv_morning_vol_corr    Pearson correlation of per-minute (Δ implied_vol,
 *                            Δ cumulative volume) for the strike, restricted
 *                            to executed_at ≤ 11:00 CT. Higher = real demand
 *                            bidding IV up.
 *
 * Both features are absolute (no day-context). The pass flag is computed
 * downstream from per-day percentiles — see api/gamma-squeezes.ts.
 *
 * In-sample backtest (n=12 days, 757 strike-days, 129 winners): pairing
 * V≥5× with low-HHI ≤ p30 + high-IV-corr ≥ p80 lifts precision from 17.5%
 * (current detector) to 48.8% (full stack at top 20%) on `+100% opt_ret`
 * winners. See spec: docs/superpowers/specs/precision-stack-overlay-2026-04-30.md.
 */

// ── Tunable constants ────────────────────────────────────────

/** ±0.5% of spot for the HHI cross-strike band. */
export const PROXIMITY_BAND_PCT = 0.005;
/** IV-vol-corr restricted to executed_at < this CT hour (11 = 8:30-10:59 CT). */
export const IV_MORNING_CUTOFF_HOUR_CT = 11;
/** Below this many minutes of IV data, return null (insufficient signal). */
export const MIN_IV_SAMPLES = 5;
/** Below this many strikes in band, HHI is meaningless — return null. */
export const MIN_BAND_STRIKES = 3;
/**
 * Per-day HHI percentile cutoff for `precision_stack_pass`. Strike must be
 * in the bottom HHI_PASS_PERCENTILE of the day to pass (low HHI = diffuse).
 */
export const HHI_PASS_PERCENTILE = 0.3;
/**
 * Per-day IV-corr percentile cutoff. Strike must be in the top
 * (1 − IV_VOL_CORR_PASS_PERCENTILE) of the day (high corr = real demand).
 */
export const IV_VOL_CORR_PASS_PERCENTILE = 0.8;

// ── Public types ─────────────────────────────────────────────

/** One strike's snapshot for the HHI band computation. */
export interface BandStrikeSample {
  strike: number;
  /** Cumulative intraday volume (raw). */
  volume: number;
  /** Per-share mid-price; notional = volume × midPrice × 100. */
  midPrice: number;
}

/** One per-minute observation for the IV trajectory. */
export interface IvVolSample {
  /** ISO timestamp. Used only to sort defensively. */
  ts: string;
  /** Implied volatility (mid). */
  iv: number;
  /** Cumulative intraday volume at that minute. */
  volume: number;
}

// ── Pure feature computations ────────────────────────────────

/**
 * Cross-strike Herfindahl of notional ($-volume) within a price band.
 * Returns null when fewer than MIN_BAND_STRIKES contribute non-zero
 * notional, or total notional is zero. Caller is responsible for
 * filtering to the right band (this function does not know the spot).
 */
export function computeHhi(
  strikes: readonly BandStrikeSample[],
): number | null {
  if (strikes.length < MIN_BAND_STRIKES) return null;
  const notionals: number[] = [];
  for (const s of strikes) {
    if (
      Number.isFinite(s.volume) &&
      Number.isFinite(s.midPrice) &&
      s.volume > 0 &&
      s.midPrice > 0
    ) {
      notionals.push(s.volume * s.midPrice * 100);
    }
  }
  if (notionals.length < MIN_BAND_STRIKES) return null;
  let total = 0;
  for (const n of notionals) total += n;
  if (total <= 0) return null;
  let hhi = 0;
  for (const n of notionals) {
    const share = n / total;
    hhi += share * share;
  }
  return hhi;
}

/**
 * Pearson correlation of per-minute (Δ iv, Δ volume) sequences. Caller is
 * responsible for restricting `samples` to the morning window
 * (executed_at ≤ 11:00 CT). Returns null when there are fewer than
 * MIN_IV_SAMPLES deltas or either series has zero variance.
 *
 * Sort is defensive — we sort by ts ascending before differencing so
 * upstream ordering bugs can't poison the result.
 */
export function computeIvMorningVolCorr(
  samples: readonly IvVolSample[],
): number | null {
  if (samples.length < MIN_IV_SAMPLES + 1) return null;
  const sorted = [...samples].sort(
    (a, b) => Date.parse(a.ts) - Date.parse(b.ts),
  );
  const ivChanges: number[] = [];
  const volChanges: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (
      !Number.isFinite(prev.iv) ||
      !Number.isFinite(cur.iv) ||
      !Number.isFinite(prev.volume) ||
      !Number.isFinite(cur.volume)
    ) {
      continue;
    }
    ivChanges.push(cur.iv - prev.iv);
    volChanges.push(cur.volume - prev.volume);
  }
  if (ivChanges.length < MIN_IV_SAMPLES) return null;
  let meanIv = 0;
  let meanVol = 0;
  for (let i = 0; i < ivChanges.length; i += 1) {
    meanIv += ivChanges[i]!;
    meanVol += volChanges[i]!;
  }
  meanIv /= ivChanges.length;
  meanVol /= ivChanges.length;
  let num = 0;
  let denomIv = 0;
  let denomVol = 0;
  for (let i = 0; i < ivChanges.length; i += 1) {
    const dIv = ivChanges[i]! - meanIv;
    const dVol = volChanges[i]! - meanVol;
    num += dIv * dVol;
    denomIv += dIv * dIv;
    denomVol += dVol * dVol;
  }
  if (denomIv === 0 || denomVol === 0) return null;
  const corr = num / Math.sqrt(denomIv * denomVol);
  return Number.isFinite(corr) ? corr : null;
}

/**
 * Numeric quantile via linear interpolation on a sorted copy of `values`.
 * Mirrors numpy.quantile(method='linear') — used by the read endpoint to
 * compute per-day percentiles when stamping the on-the-fly pass flag.
 */
export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  const frac = pos - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

/**
 * Apply the per-day pass rule given absolute HHI and IV-vol-corr values
 * plus the day's distribution. Returns false (not null) when either input
 * is null — pass requires both signals to be present.
 */
export function evaluatePrecisionPass(
  hhi: number | null,
  ivVolCorr: number | null,
  dayHhiP30: number | null,
  dayIvCorrP80: number | null,
): boolean {
  if (hhi == null || ivVolCorr == null) return false;
  if (dayHhiP30 == null || dayIvCorrP80 == null) return false;
  return hhi <= dayHhiP30 && ivVolCorr >= dayIvCorrP80;
}
