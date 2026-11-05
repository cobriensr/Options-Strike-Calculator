/**
 * Shared types + numeric constants for the StrikeMoverLadder family.
 * Co-located so the sign classifier and the aggregation pipeline read the
 * same ATM band and cross-asset tolerance.
 */

/**
 * The two GEXBot models the ladder can show, one tab each. The value is the
 * `endpoint` the capture cron stores: `classic` is GEX by volume (calls +,
 * puts −), `state` is the GEX imbalance from classified taker flow. They are
 * never mixed on one scale.
 */
export type ModelTab = 'classic' | 'state';

/**
 * Underlyings the ladder plots. ES_SPX and NQ_NDX are the SPX and NDX chains
 * shifted to futures levels (92.8% identical maxchange values), so they are
 * not plotted and never count as confirmation.
 */
export type LadderSymbol = 'SPX' | 'SPY';

export interface AggregatedRow {
  /** SPX-equivalent strike, rounded to nearest 5. */
  strike: number;
  /** Signed 5-minute change for the row (SPX sample if present, else first). */
  change: number;
  /** Symbols present at this strike (deduped, canonical display order). */
  symbols: LadderSymbol[];
  /** Distinct underlyings agreeing on sign: 0 (no badge) or 2. */
  confirmCount: 0 | 2;
  /** True when this row holds the largest |change| in the visible set. */
  isLargestMover: boolean;
}

/** Width of the near-spot band, in basis points of spot. 25 bps ≈ ±0.25%. */
export const NEAR_SPOT_BAND_BPS = 25;

/** ±N points around a strike used to bin cross-asset winners together. */
export const CROSS_ASSET_TOLERANCE_PTS = 5;

/** Multiplier to convert SPY strikes to SPX-equivalent strikes. */
export const SPY_TO_SPX_RATIO = 10;

/** Maximum rows rendered per side (above, below spot). */
export const MAX_ROWS_PER_SIDE = 5;

/** Minimum bar fill % when a row's |change| is non-zero. Mirrors CharmClock. */
export const MIN_BAR_PCT = 4;

/** The only maxchange category the ladder reads: GEX, 0DTE. */
export const LADDER_CATEGORY = 'gex_zero/maxchange';

/** Tab label per model. */
export const MODEL_LABEL: Record<ModelTab, string> = {
  classic: 'Classic GEX',
  state: 'State (taker)',
};

/** One-line legend per model: what the numbers on the tab are. */
export const MODEL_LEGEND: Record<ModelTab, string> = {
  classic: 'Classic GEX by volume — calls +, puts −; biggest change by strike',
  state: 'GEXBot State — taker-flow GEX imbalance; biggest change by strike',
};
