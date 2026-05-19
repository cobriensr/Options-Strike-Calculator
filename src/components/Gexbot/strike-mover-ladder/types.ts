/**
 * Shared types + numeric constants for the StrikeMoverLadder family.
 * Co-located so both the color classifier and the aggregation pipeline
 * read the same ATM band and cross-asset tolerance.
 */

export type Side = 'above' | 'below' | 'atm';
export type Tone = 'strengthening' | 'weakening' | 'magnet';
export type CategoryTab = 'gex' | 'gamma' | 'delta' | 'vanna' | 'charm';
export type LadderSymbol = 'SPX' | 'ES_SPX' | 'SPY';

export interface ClassifiedRow {
  side: Side;
  tone: Tone;
  toneClass: string;
  marker: '▽' | '◈ ATM' | null;
}

export interface AggregatedRow {
  /** SPX-equivalent strike, rounded to nearest 5. */
  strike: number;
  /** Signed 5-minute Δ for the row (SPX sample if present, else first). */
  change: number;
  /** Symbols present at this strike (deduped, canonical display order). */
  symbols: LadderSymbol[];
  /** Number of symbols agreeing on direction: 0 (no badge), 2, or 3. */
  confirmCount: 0 | 2 | 3;
  /** True when this row holds the largest |change| in the visible set. */
  isLargestMover: boolean;
}

/** Width of the ATM band, in basis points of spot. 25 bps ≈ ±0.25%. */
export const ATM_BAND_BPS = 25;

/** ±N points around a strike used to bin cross-asset winners together. */
export const CROSS_ASSET_TOLERANCE_PTS = 5;

/** Multiplier to convert SPY strikes to SPX-equivalent strikes. */
export const SPY_TO_SPX_RATIO = 10;

/** Maximum rows rendered per side (ceilings, floors). */
export const MAX_ROWS_PER_SIDE = 5;

/** Minimum bar fill % when a row's |change| is non-zero. Mirrors CharmClock. */
export const MIN_BAR_PCT = 4;

/** GEXBot endpoint suffix that every 0DTE state category shares. */
export const GEXBOT_MAXCHANGE_SUFFIX = '/maxchange';

/** Maps the on-screen tab to GEXBot's 0DTE category key. */
export const CATEGORY_TO_GEXBOT_KEY: Record<CategoryTab, string> = {
  gex: 'gex_zero',
  gamma: 'gamma_zero',
  delta: 'delta_zero',
  vanna: 'vanna_zero',
  charm: 'charm_zero',
};

/** Display label for each tab. */
export const CATEGORY_LABEL: Record<CategoryTab, string> = {
  gex: 'GEX',
  gamma: 'γ',
  delta: 'Δ',
  vanna: 'V',
  charm: 'CH',
};
