/**
 * Shared types for the GexTarget pipeline.
 *
 * Three layers of data, reflected in the type hierarchy:
 *   - Layer 1 (raw snapshots): `GexSnapshot` + `GexStrikeRow` — the
 *     on-disk shape written by the cron.
 *   - Layer 2 (calculated features): `MagnetFeatures` — what the
 *     extractor produces per strike per mode.
 *   - Layer 3 (scores): `ComponentScores`, `StrikeScore`, `TargetScore` —
 *     what the scorers and pipeline produce.
 *
 * `PriceMovementContext` is board-level and threaded through the
 * per-strike scorer rather than duplicated on every `MagnetFeatures`.
 */

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
  prevGexDollars_10m: number | null;
  prevGexDollars_15m: number | null;
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
  /** 20-minute trend anchor — prevents short-term consolidation from
   * disqualifying a strike that has been attracting flow all session. */
  deltaSpot_20m: number;
}

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
