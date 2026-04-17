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
    h10m: 10,
    h15m: 15,
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
