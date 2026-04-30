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

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance =
    xs.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
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

  const seedDateUtc = seed.capturedAt.toISOString().slice(0, 10);
  const inSameSession = sorted.filter(
    (t) => t.capturedAt.toISOString().slice(0, 10) === seedDateUtc,
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
  let weightedSum = 0;
  let weightTotal = 0;
  for (const t of candidates) {
    const ageMin =
      (seed.capturedAt.getTime() - t.capturedAt.getTime()) / 60_000;
    const weight = Math.max(0, 1 - ageMin / WINDOW_MINUTES);
    weightedSum += t.predictedClose * weight;
    weightTotal += weight;
  }
  const consensusClose = weightedSum / weightTotal;
  const sd = stdev(candidates.map((t) => t.predictedClose));

  return {
    consensusClose,
    stdev: sd,
    agreementCount: candidates.length,
    sourceTickIds: candidates.map((t) => t.id),
  };
}
