/**
 * GexTarget scoring math: pure component scorers that turn per-strike
 * gamma-exposure (GEX) features into a composite "target strike" signal.
 *
 * This is the v1 rebuild of the GEX magnet logic. It replaces the old
 * `gex-migration.ts` module with a spec-driven, multi-mode scoring
 * pipeline described in
 * `docs/superpowers/plans/gex-target-rebuild.md`, Appendix C.
 *
 * Design notes:
 * - Every function in this file is pure and synchronous. No React, no
 *   network, no database. The scorers are called from a `useMemo` on
 *   the frontend after the board-history hook delivers snapshots.
 * - Each scorer has a bounded output range (documented in its JSDoc)
 *   so the composite score in Appendix C.4 has a predictable envelope.
 * - Null-handling is explicit: a null horizon in `flowConfluence` is
 *   dropped and the remaining weights are renormalized, so early-session
 *   snapshots (no 20m / 60m history yet) still produce usable signal.
 *
 * See `src/__tests__/utils/gex-target.components.test.ts` for the
 * exhaustive test matrix (Appendix D of the plan doc).
 */

// ── Types ─────────────────────────────────────────────────────────────

/**
 * The three parallel scoring modes. Each mode reads its own column set
 * from the snapshot (see the "Three parallel scoring modes"
 * architectural commitment in the plan doc) and produces an independent
 * `TargetScore`. The three are not combined — the component decides
 * which one to display.
 *
 * - `oi`  — open-interest-weighted GEX
 * - `vol` — volume-weighted GEX (intraday flow)
 * - `dir` — directional (signed) GEX
 */
export type Mode = 'oi' | 'vol' | 'dir';

/**
 * Which side of the order book a "wall" sits on. Derived from the sign
 * of `gexDollars` at the strike, NOT from the sign of `finalScore`. A
 * growing call wall and a dying call wall both have `wallSide = 'CALL'`;
 * the difference shows up in `finalScore` (positive for growing,
 * negative for dying).
 */
export type WallSide = 'CALL' | 'PUT' | 'NEUTRAL';

/**
 * Conviction tier assigned from `abs(finalScore)`:
 * - `HIGH`   — abs > 0.50
 * - `MEDIUM` — abs > 0.30
 * - `LOW`    — abs > 0.15
 * - `NONE`   — anything less (board is churning, no target)
 */
export type Tier = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

/**
 * Per-strike features extracted from a snapshot sequence for one mode.
 * This is the **Layer 2** (calculated features) record in the three-layer
 * data architecture: raw snapshots → features → scoring outputs. Every
 * field is produced by `extractFeatures` and persisted to the
 * `gex_target_features` table alongside the Layer 3 composite scores,
 * so the ML pipeline can query any transformation in isolation.
 *
 * The four delta horizons carry **three parallel representations**:
 *
 * 1. `deltaGex_*`  — signed dollar delta vs the prior snapshot at that
 *    offset. Preserved for reconstruction and absolute-magnitude queries.
 * 2. `prevGexDollars_*` — the prior-snapshot value at that offset.
 *    Preserved so a later re-score can compute Δ% with a different
 *    normalization if needed.
 * 3. `deltaPct_*` — the percentage delta, normalized by the **same**
 *    horizon's prior (not a shared baseline). This is what
 *    `flowConfluence` actually reads. Persisting the percentages
 *    directly lets the ML pipeline train thresholds on them without
 *    reconstructing from the dollar deltas + priors.
 *
 * Each horizon's Δ% is normalized against **its own** prior value:
 *
 *     deltaPct_5m = deltaGex_5m / |prevGexDollars_5m|
 *
 * NOT against `prevGexDollars_1m`. Using a shared 1-minute baseline
 * would corrupt every horizon above 1m and produce a meaningless
 * "percentage" that the ML pipeline could not threshold.
 */
export interface MagnetFeatures {
  strike: number;
  spot: number;
  distFromSpot: number;
  /** Signed GEX in dollars; positive = net long gamma, negative = short. */
  gexDollars: number;
  /** Call-side GEX in dollars for the active mode (display only, not persisted). */
  callGexDollars: number;
  /** Put-side GEX in dollars for the active mode (display only, not persisted). */
  putGexDollars: number;
  /** Call-side delta exposure (Σ delta×OI across calls) from greek_exposure_strike. Display only, not persisted. Null when history data is unavailable. */
  callDelta: number | null;
  /** Put-side delta exposure (Σ delta×OI across puts) from greek_exposure_strike. Display only, not persisted. Null when history data is unavailable. */
  putDelta: number | null;
  // ── Layer 2: per-horizon deltas (three parallel representations) ──
  /** Signed Δ$ vs the 1-minute-prior snapshot, or null if unavailable. */
  deltaGex_1m: number | null;
  deltaGex_5m: number | null;
  deltaGex_20m: number | null;
  deltaGex_60m: number | null;
  /** The 1-minute-prior snapshot's gexDollars, or null if unavailable. */
  prevGexDollars_1m: number | null;
  prevGexDollars_5m: number | null;
  prevGexDollars_20m: number | null;
  prevGexDollars_60m: number | null;
  /**
   * Signed Δ% vs the prior snapshot at the same horizon. `deltaPct_5m`
   * uses `prevGexDollars_5m` as its denominator, NOT `prevGexDollars_1m`.
   * Null when the horizon's prior is null or zero (can't divide).
   */
  deltaPct_1m: number | null;
  deltaPct_5m: number | null;
  deltaPct_20m: number | null;
  deltaPct_60m: number | null;
  /** (callVol - putVol) / (callVol + putVol), in [-1, 1]. */
  callRatio: number;
  /** Net charm (dDelta/dt) at the strike, signed. Scored in v1. */
  charmNet: number;
  /** Net DEX at the strike, signed. Stored in v1, NOT scored (Appendix I). */
  deltaNet: number;
  /** Net VEX at the strike, signed. Stored in v1, NOT scored (Appendix I). */
  vannaNet: number;
  /** 0 at noon CT, 180 at 3pm CT. Clamped into [0, 180] by the extractor. */
  minutesAfterNoonCT: number;
}

/**
 * The six bounded component scores that feed the composite. Ranges are
 * documented per-scorer below; `flowConfluence`, `priceConfirm`, and
 * `charmScore` are signed in `[-1, 1]`, while `dominance`, `clarity`,
 * and `proximity` are unsigned in `[0, 1]`.
 */
export interface ComponentScores {
  flowConfluence: number;
  priceConfirm: number;
  charmScore: number;
  dominance: number;
  clarity: number;
  proximity: number;
}

/**
 * The per-strike scored record returned by the strike scorer. Every
 * field except `features` is computed from `features` plus the
 * universe-wide peer arrays; `features` is kept verbatim so the UI can
 * render breakdowns without re-extracting anything.
 */
export interface StrikeScore {
  strike: number;
  features: MagnetFeatures;
  components: ComponentScores;
  /** Signed composite, roughly in [-0.85, +0.85] in practice. */
  finalScore: number;
  tier: Tier;
  wallSide: WallSide;
  /** 1..10 within the mode, by `abs(finalScore)` descending. */
  rankByScore: number;
  /** 1..10 within the mode, by `abs(gexDollars)` descending. */
  rankBySize: number;
  /** True for the #1-by-score row iff its tier is not `NONE`. */
  isTarget: boolean;
}

/**
 * The result of scoring one mode: the winning target (if any) plus the
 * full leaderboard sorted by `abs(finalScore)` descending.
 */
export interface TargetScore {
  target: StrikeScore | null;
  /** Always length ≤ 10, sorted by `abs(finalScore)` descending. */
  leaderboard: StrikeScore[];
}

/**
 * Board-level spot-movement context required by `priceConfirm`. Spot is
 * the same for every strike in a snapshot, so the board-level Δ values
 * are computed once and threaded through the per-strike scorer rather
 * than duplicated on every `MagnetFeatures`.
 *
 * Units: SPX index points.
 */
export interface PriceMovementContext {
  deltaSpot_1m: number;
  deltaSpot_3m: number;
  deltaSpot_5m: number;
}

// ── Component scorers ─────────────────────────────────────────────────

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
 * The weighted move prioritizes the most-recent 1-minute move
 * (`0.5·Δ1m + 0.3·Δ3m + 0.2·Δ5m`) so stale rallies don't keep
 * confirming strikes that have already been left behind.
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
    0.5 * priceCtx.deltaSpot_1m +
    0.3 * priceCtx.deltaSpot_3m +
    0.2 * priceCtx.deltaSpot_5m;

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
 * Compute the dominance component for a strike: "how much does this
 * strike stand out from its 10-strike peer group?".
 *
 * Normalizes `|gexDollars|` against the peer distribution, where the
 * peer median maps to 0 and the peer max maps to 1. Strikes below the
 * median are clamped to 0 (not negative) — "below average" shouldn't
 * subtract from the composite; a sub-median strike just gets no
 * dominance bonus.
 *
 * The degenerate "all ten strikes equal" case returns 0.5 so a flat
 * universe doesn't nuke every composite score through the multiplicative
 * gate.
 *
 * `peerGexDollars` must contain this strike's own `|gexDollars|` value
 * (the universe median/max are computed over the full 10-strike set,
 * including the strike being scored).
 *
 * Output range: `[0, 1]`.
 */
export function dominance(
  features: MagnetFeatures,
  peerGexDollars: number[],
): number {
  if (peerGexDollars.length === 0) {
    return 0;
  }

  const peerMedian = median(peerGexDollars);
  const peerMax = Math.max(...peerGexDollars);

  // Degenerate: the entire universe has identical |GEX $|. Return 0.5
  // so the composite doesn't get gated to 0 by a flat board.
  if (peerMax === peerMedian) {
    return 0.5;
  }

  const raw =
    (Math.abs(features.gexDollars) - peerMedian) / (peerMax - peerMedian);
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

// ── Pipeline layer (Subagent 1B) ──────────────────────────────────────
//
// Everything below this line consumes the types and scorers above and
// threads them into the full mode pipeline: extract → pick universe →
// score per strike → rank → pick target. The three-mode entry point
// `computeGexTarget` is the public surface the hook / endpoint calls.

// ── Raw snapshot shape ────────────────────────────────────────────────

/**
 * One per-strike row inside a `GexSnapshot`. Field names intentionally
 * mirror `GexStrikeLevel` in `src/hooks/useGexPerStrike.ts` so the hook
 * can hand raw rows straight into the pipeline with no translation.
 *
 * Only the columns actually read by the scorer are listed here; the
 * hook's full record carries a few derived fields (`netGamma`,
 * `volReinforcement`) that the pipeline doesn't need.
 */
export interface GexStrikeRow {
  strike: number;
  price: number;
  // Gamma — OI (standing position)
  callGammaOi: number;
  putGammaOi: number;
  // Gamma — volume (intraday flow)
  callGammaVol: number;
  putGammaVol: number;
  // Gamma — directionalized (bid/ask)
  callGammaAsk: number;
  callGammaBid: number;
  putGammaAsk: number;
  putGammaBid: number;
  // Charm
  callCharmOi: number;
  putCharmOi: number;
  callCharmVol: number;
  putCharmVol: number;
  // Delta (DEX) — OI only; UW does not expose a volume variant
  callDeltaOi: number;
  putDeltaOi: number;
  // Vanna
  callVannaOi: number;
  putVannaOi: number;
  callVannaVol: number;
  putVannaVol: number;
}

/**
 * One board snapshot. A sequence of these, sorted ascending by
 * `timestamp` (latest LAST), is the input to every pipeline function.
 *
 * `price` is the spot-at-snapshot recorded by the cron; it's the same
 * for every strike in `strikes`, so scoring reads it once off the row
 * and threads it through the per-strike extractor.
 */
export interface GexSnapshot {
  /** ISO 8601 timestamp (UTC) when the cron captured the board. */
  timestamp: string;
  /** Spot SPX at snapshot time. */
  price: number;
  strikes: GexStrikeRow[];
}

// ── Configuration ─────────────────────────────────────────────────────

/**
 * Tunable knobs for the GEX target pipeline. Keeping these in one
 * object lets the backfill script and the online scorer share the same
 * constants and lets us bump `mathVersion` if we ever re-calibrate the
 * composite weights or tier thresholds (see Appendix E of the plan doc).
 */
export const GEX_TARGET_CONFIG = {
  /** Top-N strikes by |GEX $| per Appendix C.2. */
  universeSize: 10,

  /**
   * Horizon offsets in snapshot positions (1-minute cadence assumed).
   * A value of 1 means "1 snapshot before latest".
   */
  horizonOffsets: {
    h1m: 1,
    h5m: 5,
    h20m: 20,
    h60m: 60,
  },

  /** Composite score weights — Appendix C.4. */
  weights: {
    flowConfluence: 0.4,
    priceConfirm: 0.25,
    charmScore: 0.2,
    clarity: 0.15,
  },

  /** Tier thresholds on |finalScore| — Appendix C.5. */
  tierThresholds: {
    high: 0.5,
    medium: 0.3,
    low: 0.15,
  },

  /** Math version tag — persisted to `gex_target_features` on every row. */
  mathVersion: 'v1' as const,
} as const;

// ── Internal helpers ──────────────────────────────────────────────────

/**
 * Find the row for a given strike inside a snapshot. Returns `null`
 * when the strike isn't present — calling code decides whether that's
 * an error or a "null feature" signal.
 */
function findStrikeRow(
  snapshot: GexSnapshot,
  strike: number,
): GexStrikeRow | null {
  return snapshot.strikes.find((row) => row.strike === strike) ?? null;
}

/**
 * Compute the call-side GEX dollars for a strike in a given mode.
 *
 * The UW API returns values that are already dollar-weighted (they
 * include the full gamma × OI × 100 shares × spot² × 0.01 calculation).
 * So these fields are used directly without further scaling.
 */
function computeCallGex(row: GexStrikeRow, mode: Mode): number {
  switch (mode) {
    case 'oi':
      return row.callGammaOi;
    case 'vol':
      return row.callGammaVol;
    case 'dir':
      return row.callGammaAsk + row.callGammaBid;
  }
}

/** Compute the put-side GEX dollars for a strike in a given mode. */
function computePutGex(row: GexStrikeRow, mode: Mode): number {
  switch (mode) {
    case 'oi':
      return row.putGammaOi;
    case 'vol':
      return row.putGammaVol;
    case 'dir':
      return row.putGammaAsk + row.putGammaBid;
  }
}

/**
 * Compute the signed net GEX dollars for a strike in a given mode.
 *
 * UW API values are already dollar-weighted — no further scaling needed.
 * DIR mode sums all four directionalized columns (ask + bid on calls and
 * puts) to get the net directionalized gamma magnitude.
 */
function computeGexDollars(row: GexStrikeRow, mode: Mode): number {
  return computeCallGex(row, mode) + computePutGex(row, mode);
}

/**
 * Extract the net charm for a strike in a given mode. OI and DIR modes
 * both read the OI columns (UW does not expose directionalized charm);
 * only VOL mode reads the volume columns.
 */
function computeCharmNet(row: GexStrikeRow, mode: Mode): number {
  if (mode === 'vol') {
    return row.callCharmVol + row.putCharmVol;
  }
  return row.callCharmOi + row.putCharmOi;
}

/**
 * Extract the net delta (DEX) for a strike. UW only exposes OI-weighted
 * DEX, so every mode reads the same columns. DEX is stored but not
 * scored in v1 — see Appendix I of the plan doc.
 */
function computeDeltaNet(row: GexStrikeRow): number {
  return row.callDeltaOi + row.putDeltaOi;
}

/**
 * Extract the net vanna (VEX) for a strike in a given mode. Same
 * OI-vs-VOL convention as charm. VEX is stored but not scored in v1.
 */
function computeVannaNet(row: GexStrikeRow, mode: Mode): number {
  if (mode === 'vol') {
    return row.callVannaVol + row.putVannaVol;
  }
  return row.callVannaOi + row.putVannaOi;
}

/**
 * Compute the call-vs-put volume ratio for a strike. Always reads the
 * volume columns regardless of mode — clarity is intrinsically a
 * today's-flow concept, and using OI here would nuke intraday signal
 * on days where call OI happens to dwarf put OI or vice versa.
 *
 * Returns `0` when the total volume is 0 (no flow → no clarity).
 */
function computeCallRatio(row: GexStrikeRow): number {
  const total = row.callGammaVol + row.putGammaVol;
  if (total === 0) {
    return 0;
  }
  return (row.callGammaVol - row.putGammaVol) / total;
}

/**
 * Convert a snapshot timestamp into "minutes after noon CT", clamped
 * into `[0, 180]`.
 *
 * Uses `toLocaleString` with the `America/Chicago` timezone so the
 * conversion Just Works across CST/CDT without us having to know which
 * half of the year we're in. We extract hour + minute from the locale
 * string rather than doing UTC-offset arithmetic because DST transitions
 * would otherwise require a table.
 */
function computeMinutesAfterNoonCT(isoTimestamp: string): number {
  const date = new Date(isoTimestamp);
  // en-GB gives a zero-padded 24-hour time we can slice cleanly.
  const timeString = date.toLocaleString('en-GB', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const [hourStr, minuteStr] = timeString.split(':');
  const hour = Number.parseInt(hourStr ?? '0', 10);
  const minute = Number.parseInt(minuteStr ?? '0', 10);
  const minutesAfterNoon = (hour - 12) * 60 + minute;
  return Math.max(0, Math.min(180, minutesAfterNoon));
}

/**
 * One horizon's three parallel representations: the prior-snapshot
 * gexDollars, the signed dollar delta vs that prior, and the Δ%
 * normalized against that same prior.
 *
 * `pct` is null when `prior` is null or exactly 0 (division would
 * produce a useless value). `delta` is null only when `prior` is null.
 */
interface HorizonValues {
  prior: number | null;
  delta: number | null;
  pct: number | null;
}

/**
 * Look up the prior-snapshot gexDollars for this strike at `offset`
 * positions before the latest snapshot, then derive the signed dollar
 * delta and the Δ% normalized against that same prior.
 *
 * Each horizon uses its own prior — **no shared baseline**. A 20-minute
 * horizon's Δ% is `(latest - prior_20m) / |prior_20m|`, not
 * `(latest - prior_20m) / |prior_1m|`. Using a shared baseline would
 * produce a meaningless ratio that the ML pipeline could not threshold.
 *
 * Returns all-null when the history is too short to reach back that
 * far, or when the prior snapshot is missing the strike entirely (new
 * listing mid-day). `flowConfluence` handles the null case by dropping
 * that horizon and renormalizing the remaining weights.
 */
function computeHorizon(
  snapshots: GexSnapshot[],
  offset: number,
  strike: number,
  mode: Mode,
  latestGexDollars: number,
): HorizonValues {
  const latestIdx = snapshots.length - 1;
  const priorIdx = latestIdx - offset;
  if (priorIdx < 0) {
    return { prior: null, delta: null, pct: null };
  }
  const priorSnapshot = snapshots[priorIdx];
  if (!priorSnapshot) {
    return { prior: null, delta: null, pct: null };
  }
  const priorRow = findStrikeRow(priorSnapshot, strike);
  if (!priorRow) {
    return { prior: null, delta: null, pct: null };
  }
  const prior = computeGexDollars(priorRow, mode);
  const delta = latestGexDollars - prior;
  const pct = prior !== 0 ? delta / Math.abs(prior) : null;
  return { prior, delta, pct };
}

// ── Feature extraction ────────────────────────────────────────────────

/**
 * Extract the per-strike `MagnetFeatures` for one strike in one mode.
 *
 * `snapshots` must be sorted ascending by timestamp (latest LAST). The
 * function reads the latest snapshot to get current gamma / charm /
 * volume columns, and walks back 1/5/20/60 snapshots to compute the
 * four delta horizons. Missing history produces `null` delta horizons —
 * `flowConfluence` handles the renormalization.
 *
 * Throws if the strike isn't present in the latest snapshot. Callers
 * should only invoke this with strikes returned by `pickUniverse`,
 * which guarantees presence.
 */
export function extractFeatures(
  snapshots: GexSnapshot[],
  mode: Mode,
  strike: number,
): MagnetFeatures {
  if (snapshots.length === 0) {
    throw new Error('extractFeatures: snapshots array is empty');
  }
  const latest = snapshots.at(-1);
  if (!latest) {
    throw new Error('extractFeatures: failed to read latest snapshot');
  }
  const latestRow = findStrikeRow(latest, strike);
  if (!latestRow) {
    throw new Error(
      `extractFeatures: strike ${strike} not present in latest snapshot`,
    );
  }

  const spot = latest.price;
  const gexDollars = computeGexDollars(latestRow, mode);
  const callGexDollars = computeCallGex(latestRow, mode);
  const putGexDollars = computePutGex(latestRow, mode);
  const { horizonOffsets } = GEX_TARGET_CONFIG;

  // Compute all four horizons in one pass. Each horizon call returns
  // the triple (prior, delta, pct) — storing all three in
  // MagnetFeatures preserves the Layer 2 (calculated inputs) state so
  // the ML pipeline can query any transformation without reconstructing.
  const h1m = computeHorizon(
    snapshots,
    horizonOffsets.h1m,
    strike,
    mode,
    gexDollars,
  );
  const h5m = computeHorizon(
    snapshots,
    horizonOffsets.h5m,
    strike,
    mode,
    gexDollars,
  );
  const h20m = computeHorizon(
    snapshots,
    horizonOffsets.h20m,
    strike,
    mode,
    gexDollars,
  );
  const h60m = computeHorizon(
    snapshots,
    horizonOffsets.h60m,
    strike,
    mode,
    gexDollars,
  );

  return {
    strike,
    spot,
    distFromSpot: strike - spot,
    gexDollars,
    callGexDollars,
    putGexDollars,
    callDelta: null,
    putDelta: null,
    deltaGex_1m: h1m.delta,
    deltaGex_5m: h5m.delta,
    deltaGex_20m: h20m.delta,
    deltaGex_60m: h60m.delta,
    prevGexDollars_1m: h1m.prior,
    prevGexDollars_5m: h5m.prior,
    prevGexDollars_20m: h20m.prior,
    prevGexDollars_60m: h60m.prior,
    deltaPct_1m: h1m.pct,
    deltaPct_5m: h5m.pct,
    deltaPct_20m: h20m.pct,
    deltaPct_60m: h60m.pct,
    callRatio: computeCallRatio(latestRow),
    charmNet: computeCharmNet(latestRow, mode),
    deltaNet: computeDeltaNet(latestRow),
    vannaNet: computeVannaNet(latestRow, mode),
    minutesAfterNoonCT: computeMinutesAfterNoonCT(latest.timestamp),
  };
}

// ── Universe selection ────────────────────────────────────────────────

/**
 * Pick the top-`universeSize` strikes by `|gexDollars|` in the given
 * mode. Returns an array of strike values (plain numbers) — the
 * features are extracted later by `extractFeatures`.
 *
 * Appendix C.2 "admission ticket": strikes without meaningful standing
 * gamma are ignored regardless of their flow story. A strike's raw
 * size is the filter that decides whether it even gets scored.
 *
 * Ties are broken by strike value ascending, so the ordering is
 * deterministic across runs (important for snapshot diffing).
 */
export function pickUniverse(
  latestSnapshot: GexSnapshot,
  mode: Mode,
): number[] {
  const withSize = latestSnapshot.strikes.map((row) => ({
    strike: row.strike,
    absGex: Math.abs(computeGexDollars(row, mode)),
  }));

  withSize.sort((a, b) => {
    if (a.absGex !== b.absGex) {
      return b.absGex - a.absGex;
    }
    return a.strike - b.strike;
  });

  return withSize.slice(0, GEX_TARGET_CONFIG.universeSize).map((x) => x.strike);
}

// ── Per-strike scoring ────────────────────────────────────────────────

/**
 * Assign a `Tier` from `|finalScore|` per Appendix C.5.
 *
 * Thresholds are strict `>` (not `>=`), so a score exactly equal to a
 * threshold falls into the LOWER tier. This matches the spec's
 * inequalities literally.
 */
function assignTier(finalScore: number): Tier {
  const abs = Math.abs(finalScore);
  const { high, medium, low } = GEX_TARGET_CONFIG.tierThresholds;
  if (abs > high) return 'HIGH';
  if (abs > medium) return 'MEDIUM';
  if (abs > low) return 'LOW';
  return 'NONE';
}

/**
 * Assign a `WallSide` per Appendix C.6. NONE tier always collapses to
 * NEUTRAL regardless of gamma sign, so the panel never shows a wall
 * label for a churning strike.
 */
function assignWallSide(tier: Tier, gexDollars: number): WallSide {
  if (tier === 'NONE') return 'NEUTRAL';
  if (gexDollars > 0) return 'CALL';
  if (gexDollars < 0) return 'PUT';
  return 'NEUTRAL';
}

/**
 * Score one strike. Calls all six component scorers, runs the composite
 * formula from Appendix C.4, assigns tier and wall side, and returns a
 * `StrikeScore` with `rankByScore` and `rankBySize` temporarily set to
 * 0 — `scoreMode` fills those in after sorting the full universe.
 *
 * `peerGexDollars` MUST include this strike's own `|gexDollars|`; it's
 * the universe-wide array used by `dominance` to compute the peer
 * median and max.
 */
export function scoreStrike(
  features: MagnetFeatures,
  priceCtx: PriceMovementContext,
  peerGexDollars: number[],
): StrikeScore {
  const components: ComponentScores = {
    flowConfluence: flowConfluence(features),
    priceConfirm: priceConfirm(features, priceCtx),
    charmScore: charmScore(features),
    dominance: dominance(features, peerGexDollars),
    clarity: clarity(features),
    proximity: proximity(features),
  };

  const { weights } = GEX_TARGET_CONFIG;
  const finalScore =
    weights.flowConfluence *
      components.flowConfluence *
      components.dominance *
      components.proximity +
    weights.priceConfirm *
      components.priceConfirm *
      components.dominance *
      components.proximity +
    weights.charmScore * components.charmScore * components.proximity +
    weights.clarity * (components.clarity - 0.5);

  const tier = assignTier(finalScore);
  const wallSide = assignWallSide(tier, features.gexDollars);

  return {
    strike: features.strike,
    features,
    components,
    finalScore,
    tier,
    wallSide,
    rankByScore: 0,
    rankBySize: 0,
    isTarget: false,
  };
}

// ── Mode-level pipeline ───────────────────────────────────────────────

/**
 * Compute board-level spot movement deltas once per snapshot sequence.
 * `priceConfirm` is the only consumer, and it needs 1/3/5 minute horizons.
 *
 * Missing history (fewer snapshots than required) falls back to 0 for
 * the missing horizons. This lets the pipeline produce usable scores
 * during the first few minutes of a session without the extractor
 * having to special-case the partial-window state.
 */
function computePriceMovementContext(
  snapshots: GexSnapshot[],
): PriceMovementContext {
  const latest = snapshots.at(-1);
  if (!latest) {
    return { deltaSpot_1m: 0, deltaSpot_3m: 0, deltaSpot_5m: 0 };
  }

  const spotAtOffset = (offset: number): number => {
    const idx = snapshots.length - 1 - offset;
    if (idx < 0) return latest.price;
    return snapshots[idx]?.price ?? latest.price;
  };

  return {
    deltaSpot_1m: latest.price - spotAtOffset(1),
    deltaSpot_3m: latest.price - spotAtOffset(3),
    deltaSpot_5m: latest.price - spotAtOffset(5),
  };
}

/**
 * Score one mode (OI, VOL, or DIR). This is the per-mode entry point:
 *
 * 1. Build the universe from the latest snapshot.
 * 2. Compute the board-level price movement context once.
 * 3. Extract features for each universe strike and score it.
 * 4. Sort by `|finalScore|` desc and assign `rankByScore`.
 * 5. Sort a copy by `|gexDollars|` desc and assign `rankBySize`.
 * 6. Set `isTarget = true` on the top-by-score strike iff its tier is
 *    not NONE. Otherwise the target is `null` and the panel renders
 *    "board churning" — this is the first-class no-confluence case.
 *
 * Returns an empty `TargetScore` when the input is too short to
 * compute a 1-minute delta (length < 2).
 */
export function scoreMode(snapshots: GexSnapshot[], mode: Mode): TargetScore {
  if (snapshots.length < 2) {
    return { target: null, leaderboard: [] };
  }

  const latest = snapshots.at(-1);
  if (!latest) {
    return { target: null, leaderboard: [] };
  }

  const universe = pickUniverse(latest, mode);
  if (universe.length === 0) {
    return { target: null, leaderboard: [] };
  }

  const priceCtx = computePriceMovementContext(snapshots);

  // Extract features for every strike in the universe first so we can
  // build the peer |gexDollars| array before scoring (dominance needs
  // the full peer set).
  const featuresList: MagnetFeatures[] = universe.map((strike) =>
    extractFeatures(snapshots, mode, strike),
  );
  const peerGexDollars = featuresList.map((f) => Math.abs(f.gexDollars));

  const unranked: StrikeScore[] = featuresList.map((features) =>
    scoreStrike(features, priceCtx, peerGexDollars),
  );

  // Rank by score: sort by |finalScore| desc, assign 1..N.
  const sortedByScore = [...unranked].sort(
    (a, b) => Math.abs(b.finalScore) - Math.abs(a.finalScore),
  );
  sortedByScore.forEach((entry, i) => {
    entry.rankByScore = i + 1;
  });

  // Rank by size: sort a copy by |gexDollars| desc, assign 1..N. We
  // write `rankBySize` onto the same objects — `unranked`/`sortedByScore`
  // reference the same records, so both ranks land on every entry.
  const sortedBySize = [...unranked].sort(
    (a, b) => Math.abs(b.features.gexDollars) - Math.abs(a.features.gexDollars),
  );
  sortedBySize.forEach((entry, i) => {
    entry.rankBySize = i + 1;
  });

  // Target selection: #1-by-score, but only if its tier is not NONE.
  const topByScore = sortedByScore[0];
  if (topByScore && topByScore.tier !== 'NONE') {
    topByScore.isTarget = true;
  }

  const target = topByScore && topByScore.tier !== 'NONE' ? topByScore : null;

  return { target, leaderboard: sortedByScore };
}

// ── Top-level pipeline ────────────────────────────────────────────────

/**
 * Top-level three-mode pipeline. Runs the OI, VOL, and DIR scoring
 * independently and returns all three results. The three are NOT
 * combined — the component decides which one to display, and the ML
 * pipeline trains on all three in parallel.
 *
 * Short-circuits to three empty `TargetScore`s when there's no history
 * (0 or 1 snapshot): no delta horizons can be computed from a single
 * snapshot, so every mode would produce degenerate scores anyway.
 */
export function computeGexTarget(snapshots: GexSnapshot[]): {
  oi: TargetScore;
  vol: TargetScore;
  dir: TargetScore;
} {
  if (snapshots.length < 2) {
    const empty: TargetScore = { target: null, leaderboard: [] };
    return { oi: empty, vol: empty, dir: empty };
  }
  return {
    oi: scoreMode(snapshots, 'oi'),
    vol: scoreMode(snapshots, 'vol'),
    dir: scoreMode(snapshots, 'dir'),
  };
}
