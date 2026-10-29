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
