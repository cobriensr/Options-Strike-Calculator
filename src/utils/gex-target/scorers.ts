/**
 * Component scorers: turn per-strike `MagnetFeatures` into the six
 * bounded scalar values that feed the composite (`flowConfluence`,
 * `priceConfirm`, `charmScore`, `dominance`, `clarity`, `proximity`),
 * plus the unsigned `computeAttractingMomentum` used by `dominance`.
 *
 * Every function in this file is pure and synchronous — see the module
 * header in index.ts for the full design commitments. Output ranges are
 * documented per scorer.
 */

import type { MagnetFeatures, PriceMovementContext } from './types';

// ── Tuning constants ──────────────────────────────────────────────────

/**
 * Scale constant for `charmScore`. Represents the `|charmNet|` value at
 * which `tanh(|charmNet| / SCALE_CHARM)` reaches ≈ 0.76, i.e. where
 * charm magnitude "saturates" in the scoring model.
 *
 * Phase 10 action item: tune empirically. Appendix C.3.3 specifies
 * that this should be the 90th percentile of `abs(charmNet)` sampled
 * from real snapshots, but we have no production data at this point
 * in the rebuild. `1e8` is a placeholder that keeps mid-afternoon 0DTE
 * charm values well below saturation so the sign contributes most of
 * the signal; it should be re-tuned during the backtest session.
 */
const SCALE_CHARM = 1e8;

/**
 * Precomputed normalized `1/n` weights for the four flow horizons
 * `[1m, 5m, 20m, 60m]`:
 *
 *     raw  = [1, 1/5, 1/20, 1/60]
 *     sum  = 1 + 0.2 + 0.05 + 0.01666... = 1.26666...
 *     norm = raw / sum ≈ [0.789, 0.158, 0.039, 0.014]
 *
 * The 1-minute horizon dominates deliberately — fresh flow is the most
 * predictive signal. Longer horizons act as a "don't flip-flop" tie
 * breaker.
 */
const FLOW_WEIGHTS: readonly [number, number, number, number] = (() => {
  const raw = [1, 1 / 5, 1 / 20, 1 / 60] as const;
  const sum = raw[0] + raw[1] + raw[2] + raw[3];
  return [raw[0] / sum, raw[1] / sum, raw[2] / sum, raw[3] / sum];
})();

/** Scale constant for the flow tanh squash. 30% weighted Δ → tanh(1). */
const SCALE_FLOW_PCT = 0.3;

/** Scale constant for the price-confirm tanh squash. 3pts → tanh(1). */
const SCALE_PRICE_PTS = 3;

/** Gaussian σ (in SPX points) controlling `proximity` falloff. */
const PROXIMITY_SIGMA = 15;

// ── Scorers ───────────────────────────────────────────────────────────

/**
 * Compute the flow-confluence component for a strike.
 *
 * Multi-horizon weighted Δ% of `gexDollars`, read directly from the
 * feature record. Each horizon's Δ% is already normalized against its
 * own prior (see `MagnetFeatures` doc) — this scorer is purely the
 * weighting and `tanh` squash layer on top, with **no measurement**.
 * That separation lets the ML pipeline query the raw Δ% values out of
 * `gex_target_features` and test any threshold against outcome labels
 * without reconstructing from dollar deltas.
 *
 * Null horizons (missing snapshot history, or a horizon whose prior was
 * zero) are dropped and the remaining weights are renormalized so they
 * sum to 1. This lets the scorer work during the first ~60 minutes of a
 * session when the 20m and 60m horizons haven't filled in yet.
 *
 * Returns `0` when every horizon is null (no flow data at all).
 *
 * Output range: `[-1, 1]`, via `tanh(weighted_pct / 0.30)`.
 */
export function flowConfluence(features: MagnetFeatures): number {
  const pcts: Array<number | null> = [
    features.deltaPct_1m,
    features.deltaPct_5m,
    features.deltaPct_20m,
    features.deltaPct_60m,
  ];

  // Collect the (pct, weight) pairs for horizons that actually have
  // data. The null filter is why this scorer works on partial-window
  // sessions — the remaining weights renormalize below.
  const available: Array<{ pct: number; weight: number }> = [];
  for (let i = 0; i < pcts.length; i++) {
    const pct = pcts[i];
    const weight = FLOW_WEIGHTS[i];
    if (pct !== null && pct !== undefined && weight !== undefined) {
      available.push({ pct, weight });
    }
  }

  if (available.length === 0) {
    return 0;
  }

  // Renormalize: the surviving weights must sum to 1 so a partial
  // horizon set doesn't systematically under-score vs the full set.
  const totalWeight = available.reduce((acc, a) => acc + a.weight, 0);
  if (totalWeight === 0) {
    return 0;
  }

  let weightedPct = 0;
  for (const a of available) {
    const renormWeight = a.weight / totalWeight;
    weightedPct += a.pct * renormWeight;
  }

  return Math.tanh(weightedPct / SCALE_FLOW_PCT);
}

/**
 * Compute the price-confirmation component for a strike.
 *
 * Asks: "is the spot price actually moving toward this strike?". A
 * positive score means the recent weighted spot move is in the same
 * direction as the strike's position relative to spot (rallying toward
 * an above-spot strike or falling toward a below-spot strike).
 *
 * The weighted move blends a short-term signal with a 20-minute trend
 * anchor (`0.3·Δ1m + 0.2·Δ3m + 0.2·Δ5m + 0.3·Δ20m`). The 20m term
 * prevents a brief consolidation at the highs (normal after a rally)
 * from flip-flopping `priceConfirm` negative for an otherwise-valid
 * trending target. The 1m term retains responsiveness so the scorer
 * doesn't blindly confirm strikes that price has clearly left behind.
 *
 * Returns `0` when:
 * - The weighted move is exactly 0 (price flat)
 * - `distFromSpot` is 0 (strike at spot, `sign(0) = 0`)
 *
 * Output range: `[-1, 1]`.
 */
export function priceConfirm(
  features: MagnetFeatures,
  priceCtx: PriceMovementContext,
): number {
  const priceMove =
    0.3 * priceCtx.deltaSpot_1m +
    0.2 * priceCtx.deltaSpot_3m +
    0.2 * priceCtx.deltaSpot_5m +
    0.3 * priceCtx.deltaSpot_20m;

  if (priceMove === 0) {
    return 0;
  }

  // toward = +1 if strike is above spot, -1 if below, 0 if exactly at
  // spot (no "direction" to confirm, so the score is 0 by construction).
  const toward = Math.sign(features.strike - features.spot);
  if (toward === 0) {
    return 0;
  }

  const magnitude = Math.tanh(Math.abs(priceMove) / SCALE_PRICE_PTS);
  return magnitude * Math.sign(priceMove) * toward;
}

/**
 * Compute the charm-decay component for a strike.
 *
 * Charm (dDelta/dt) pins positive-gamma strikes harder as expiration
 * approaches. The score has three pieces:
 *
 * 1. `charmSign = sign(gexDollars) · sign(charmNet)` — positive only
 *    when charm and gamma align (a positive-gamma strike bleeding
 *    delta toward the magnet). Either term being exactly 0 zeroes the
 *    whole component.
 * 2. `charmMag = tanh(|charmNet| / SCALE_CHARM)` — bounded magnitude.
 * 3. `todWeight = max(0.3, min(1.0, minutesAfterNoonCT / 180))` — a
 *    time-of-day ramp. Charm matters most late in the session, so the
 *    weight ramps from a 0.3 floor at/below noon to 1.0 at 3pm CT.
 *
 * `minutesAfterNoonCT` is clamped in the feature extractor, but the
 * math here also handles out-of-range values defensively via the
 * explicit `max`/`min`.
 *
 * Returns `0` when `charmNet = 0` or `gexDollars = 0`.
 *
 * Output range: `[-1, 1]`.
 */
export function charmScore(features: MagnetFeatures): number {
  const { gexDollars, charmNet, minutesAfterNoonCT } = features;

  const charmSign = Math.sign(gexDollars) * Math.sign(charmNet);
  if (charmSign === 0) {
    return 0;
  }

  const charmMag = Math.tanh(Math.abs(charmNet) / SCALE_CHARM);
  const todWeight = Math.max(0.3, Math.min(1.0, minutesAfterNoonCT / 180));

  return charmSign * charmMag * todWeight;
}

/**
 * Compute the attracting momentum for a strike: the weighted dollar-delta
 * flowing INTO the wall (in the direction of the wall's polarity).
 *
 * A call wall (`gexDollars > 0`) attracts momentum when its `deltaGex`
 * is positive (GEX growing more positive). A put wall (`gexDollars < 0`)
 * attracts momentum when its `deltaGex` is negative (GEX growing more
 * negative). Flow running counter to the wall's polarity is ignored —
 * a shrinking wall has zero attracting momentum regardless of the
 * magnitude of its collapse.
 *
 * Uses the 5m (60%) and 20m (40%) horizons for a medium-term view:
 * stable enough to reflect session-level intent, responsive enough to
 * capture fresh buildup within the hour.
 *
 * Output: non-negative dollar value. Returns 0 when `gexDollars = 0`
 * (neutral wall), when both delta horizons are null, or when all
 * flow is against the wall.
 */
export function computeAttractingMomentum(features: MagnetFeatures): number {
  const wallSign = Math.sign(features.gexDollars);
  if (wallSign === 0) return 0;

  const d5m = features.deltaGex_5m ?? 0;
  const d20m = features.deltaGex_20m ?? 0;

  // Only count deltas that grow the wall in its own direction.
  const attract5m = wallSign * d5m > 0 ? Math.abs(d5m) : 0;
  const attract20m = wallSign * d20m > 0 ? Math.abs(d20m) : 0;

  return 0.6 * attract5m + 0.4 * attract20m;
}

/**
 * Compute the dominance component for a strike: "what share of the
 * board's total attracting momentum is concentrated here?".
 *
 * Replaces the prior absolute-GEX-size approach with momentum-weighted
 * dominance so that strikes gaining market-maker dollar placement rank
 * above strikes that historically dominated but are now losing GEX.
 *
 * Normalizes this strike's `computeAttractingMomentum` against the peer
 * distribution (median → 0, max → 1), mirroring the linear percentile
 * structure of the prior `|gexDollars|` formula. Strikes below the
 * median attracting momentum are clamped to 0.
 *
 * Two degenerate cases:
 * - `momentaMax = 0`: no strike on the board has attracting momentum
 *   (early session, or every wall is shrinking). Returns 0 rather than
 *   0.5 — the composite falls back to charm + clarity only.
 * - `momentaMax = momentaMedian`: all peers have equal momentum.
 *   Returns 0.5 so a flat board doesn't gate the composite to 0.
 *
 * `peerMomenta` must include this strike's own `computeAttractingMomentum`
 * value (the distribution is computed over the full 10-strike universe).
 *
 * Output range: `[0, 1]`.
 */
export function dominance(
  features: MagnetFeatures,
  peerMomenta: number[],
): number {
  if (peerMomenta.length === 0) return 0;

  const momentaMax = Math.max(...peerMomenta);

  // No attracting momentum anywhere on the board.
  if (momentaMax === 0) return 0;

  const momentaMedian = median(peerMomenta);

  // All peers have identical momentum — flat board, give everyone 0.5.
  if (momentaMax === momentaMedian) return 0.5;

  const thisMomentum = computeAttractingMomentum(features);
  const raw = (thisMomentum - momentaMedian) / (momentaMax - momentaMedian);
  return Math.max(0, Math.min(1, raw));
}

/**
 * Compute the clarity component for a strike: "how lopsided is the
 * call-vs-put volume at this strike?". A strike with 100% call volume
 * has `callRatio = 1` and `clarity = 1`; a 50/50 strike has
 * `clarity = 0`.
 *
 * NaN guards: the feature extractor is expected to pass 0 for strikes
 * with zero total volume, but we also handle NaN here defensively —
 * `abs(NaN) === NaN`, and we return 0 in that case.
 *
 * Output range: `[0, 1]`.
 */
export function clarity(features: MagnetFeatures): number {
  const { callRatio } = features;
  if (!Number.isFinite(callRatio)) {
    return 0;
  }
  return Math.abs(callRatio);
}

/**
 * Compute the proximity component for a strike: a Gaussian falloff in
 * distance from spot.
 *
 *     proximity = exp( -(distFromSpot²) / (2 · σ²) )  with σ = 15 pts
 *
 * Calibration points (from Appendix C.3.6):
 * - dist =  0 pts → 1.00
 * - dist = 15 pts → 0.6065  (= exp(-0.5))
 * - dist = 30 pts → 0.1353  (= exp(-2))
 * - dist = 45 pts → 0.0111  (= exp(-4.5))
 *
 * This acts as a soft multiplicative gate in the composite: strikes
 * far from spot can still be scored, but their contribution to the
 * `flowConfluence` and `priceConfirm` terms is vanishingly small.
 *
 * Output range: `[0, 1]`.
 */
export function proximity(features: MagnetFeatures): number {
  const d = features.distFromSpot;
  return Math.exp(-(d * d) / (2 * PROXIMITY_SIGMA * PROXIMITY_SIGMA));
}

// ── Internal helpers ──────────────────────────────────────────────────

/**
 * Median of a non-empty numeric array. Uses the "average of two middle
 * elements" convention for even-length inputs. Returns 0 for an empty
 * input so the `dominance` caller doesn't have to branch twice (it
 * already guards the empty case).
 *
 * Not exported — this is an internal helper for `dominance`.
 */
function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const lo = sorted[mid - 1] ?? 0;
    const hi = sorted[mid] ?? 0;
    return (lo + hi) / 2;
  }
  return sorted[mid] ?? 0;
}
