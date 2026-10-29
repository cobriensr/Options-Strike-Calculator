/**
 * Types shared by `api/` and `src/` for the legs of a multi-leg order.
 * Types only: no runtime code, so `api/` imports it with `import type`.
 */

/** How an anchor print relates to other legs of a larger order. */
export type AnchorLegKind = 'single' | 'multi_leg' | 'stock_tied';

/** Structure label for a group of paired legs. */
export type SpreadShape =
  | 'vertical'
  | 'calendar'
  | 'diagonal'
  | 'straddle'
  | 'combo'
  | 'butterfly'
  | 'three_leg'
  | 'four_leg'
  | 'four_leg_multi_expiry'
  | 'complex'
  | 'unpaired'
  | 'other';

/** One option leg of a multi-leg order. */
export interface SpreadLeg {
  optionType: 'C' | 'P';
  strike: number;
  expiry: string;
  size: number;
  price: number;
  tradeCode: string | null;
}

/**
 * How many of a Lottery Finder chain-day's fires printed as one leg of a
 * multi-leg order, with the shape and legs of the most recent such fire.
 * The `spreadLeg` field of /api/lottery-finder rows; null there when no
 * fire did. Spec: docs/superpowers/specs/2026-10-28-classifier-
 * replacement-design.md ("Badge").
 */
export interface SpreadLegSummary {
  /** k: spread-leg fires on the chain-day (≥ 1). */
  fires: number;
  /** n: all fires on the chain-day. */
  totalFires: number;
  /** Shape of the most recent spread-leg fire. */
  shape: SpreadShape;
  /** Legs of the most recent spread-leg fire, anchor first. */
  legs: SpreadLeg[];
}
