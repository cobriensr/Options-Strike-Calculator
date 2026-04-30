/**
 * Multi-tick session consensus for TRACE Live captures.
 *
 * Each TRACE-Live capture predicts in isolation. Within a single trading
 * session there are typically 15–25 captures, all of which agree on the
 * underlying setup but vary slightly in their numeric predictedClose.
 * The session-consensus aggregator turns that within-session ensemble
 * into a single more-stable point estimate plus a dispersion metric.
 *
 * Aggregation rules:
 *   - Restrict to captures from the same trading day (00:00–24:00 ET).
 *   - Restrict to captures with the SAME regime as the latest tick (a
 *     mid-day regime flip means earlier predictions are stale).
 *   - Weight by 1/age: a 5-min-old capture counts more than a 4-hour-old
 *     capture. Linear weight = max(0, 1 - age_minutes / WINDOW_MINUTES).
 *   - WINDOW_MINUTES = 240 (4 hours). Captures older than 4h get weight 0.
 *
 * Output: { consensusClose, stdev, agreementCount, sourceTickIds }.
 *   - consensusClose = weighted mean of predictedClose
 *   - stdev = unweighted standard deviation of the source ticks
 *     (used by the UI to indicate "consensus is wide" → low confidence)
 *   - agreementCount = number of source ticks contributing
 *   - sourceTickIds = the ids that fed the average (audit trail)
 *
 * Returns null when the session has fewer than MIN_TICKS_FOR_CONSENSUS
 * same-regime captures inside the window — single-tick consensus adds
 * no signal.
 */

export interface ConsensusInput {
  id: number;
  capturedAt: Date;
  regime: string;
  predictedClose: number;
}

export interface ConsensusResult {
  consensusClose: number;
  stdev: number;
  agreementCount: number;
  sourceTickIds: number[];
}

export const MIN_TICKS_FOR_CONSENSUS = 3;
export const WINDOW_MINUTES = 240;

/**
 * Weighted standard deviation around a weighted mean. Same linear-decay
 * weights as the consensus computation — keeps "consensus is wide → low
 * confidence" semantics consistent: an old stale outlier should not
 * inflate the dispersion as much as a fresh tick that disagrees.
 */
function weightedStdev(xs: number[], weights: number[], mean: number): number {
  if (xs.length < 2) return 0;
  let sumW = 0;
  let sumWVar = 0;
  for (let i = 0; i < xs.length; i++) {
    const w = weights[i] ?? 0;
    sumW += w;
    sumWVar += w * (xs[i]! - mean) ** 2;
  }
  if (sumW === 0) return 0;
  // Bias-corrected variance for weighted samples is non-trivial; use the
  // simple weighted-variance estimator. For our case (3-30 samples) the
  // bias is small and the metric is consumed as a relative dispersion.
  return Math.sqrt(sumWVar / sumW);
}

/**
 * Date string in ET (America/New_York) of the form YYYY-MM-DD. Used to
 * decide whether two captures are in the same trading session — UTC
 * midnight is not an ET trading-day boundary.
 */
function etDateString(d: Date): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(d);
}

/**
 * Compute the within-session consensus close from a list of recent
 * captures. The latest capture (by capturedAt) is the seed — its regime
 * is the filter, and ages are measured relative to it.
 */
export function computeSessionConsensus(
  ticks: ConsensusInput[],
): ConsensusResult | null {
  if (ticks.length === 0) return null;

  // Sort newest → oldest.
  const sorted = [...ticks].sort(
    (a, b) => b.capturedAt.getTime() - a.capturedAt.getTime(),
  );
  const seed = sorted[0]!;

  const seedDate = etDateString(seed.capturedAt);
  const inSameSession = sorted.filter(
    (t) => etDateString(t.capturedAt) === seedDate,
  );

  // Filter to same regime AND within the window.
  const candidates = inSameSession.filter((t) => {
    if (t.regime !== seed.regime) return false;
    const ageMin =
      (seed.capturedAt.getTime() - t.capturedAt.getTime()) / 60_000;
    return ageMin <= WINDOW_MINUTES;
  });

  if (candidates.length < MIN_TICKS_FOR_CONSENSUS) return null;

  // Compute the linear-decay weights (1 = seed itself, 0 = exactly at the
  // window edge). The seed's weight is 1.0; older ticks decay linearly.
  const weights = candidates.map((t) => {
    const ageMin =
      (seed.capturedAt.getTime() - t.capturedAt.getTime()) / 60_000;
    return Math.max(0, 1 - ageMin / WINDOW_MINUTES);
  });

  let weightedSum = 0;
  let weightTotal = 0;
  for (let i = 0; i < candidates.length; i++) {
    weightedSum += candidates[i]!.predictedClose * weights[i]!;
    weightTotal += weights[i]!;
  }
  const consensusClose = weightedSum / weightTotal;
  const sd = weightedStdev(
    candidates.map((t) => t.predictedClose),
    weights,
    consensusClose,
  );

  return {
    consensusClose,
    stdev: sd,
    agreementCount: candidates.length,
    sourceTickIds: candidates.map((t) => t.id),
  };
}
