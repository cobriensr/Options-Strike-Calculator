/**
 * Position types shared between `src/utils/portfolio-risk.ts` and
 * `src/components/PositionMonitor/`. Lifted from
 * `src/components/PositionMonitor/types.ts` in Phase 3C to fix the
 * inverted dependency where a pure util in `src/utils/` was importing
 * types from a UI component.
 *
 * Only the symbols actually shared across the layer boundary live here.
 * The CSV-parsing, order/trade history, and execution-quality types
 * remain co-located with the PositionMonitor component because they
 * are not consumed by `src/utils/`.
 *
 * `src/components/PositionMonitor/types.ts` re-exports the types
 * defined here so existing component-relative imports
 * (`from './types'`) continue to work without callsite churn.
 */

/** A single open option leg from the Options section of a TOS statement. */
export interface OpenLeg {
  readonly symbol: string;
  readonly optionCode: string;
  readonly exp: string;
  readonly strike: number;
  readonly type: 'CALL' | 'PUT';
  /** Signed quantity: negative = short, positive = long */
  readonly qty: number;
  readonly tradePrice: number;
  readonly mark: number | null;
  readonly markValue: number | null;
}

/** Discriminator for grouped vertical / IC positions. */
export type SpreadType =
  | 'PUT_CREDIT_SPREAD'
  | 'CALL_CREDIT_SPREAD'
  | 'IRON_CONDOR';

/** A grouped vertical spread (PCS or CCS). */
export interface Spread {
  readonly spreadType: SpreadType;
  readonly shortLeg: OpenLeg;
  readonly longLeg: OpenLeg;
  readonly contracts: number;
  readonly wingWidth: number;
  readonly creditReceived: number;
  readonly maxProfit: number;
  readonly maxLoss: number;
  readonly riskRewardRatio: number;
  readonly breakeven: number;
  /** Entry time from trade history, if matched */
  readonly entryTime: string | null;
  /** Entry net price from trade history, if matched */
  readonly entryNetPrice: number | null;
  /** Sum of (leg.mark * leg.qty * 100) if marks present */
  readonly currentValue: number | null;
  /** creditReceived - abs(currentValue) if marks present */
  readonly openPnl: number | null;
  /** (openPnl / maxProfit) * 100 if openPnl available */
  readonly pctOfMaxProfit: number | null;
  /** spotPrice - shortStrike (puts) or shortStrike - spotPrice (calls) */
  readonly distanceToShortStrike: number | null;
  /** distanceToShortStrike as pct of spotPrice */
  readonly distanceToShortStrikePct: number | null;
  /** The short leg strike closest to spot */
  readonly nearestShortStrike: number;
  /** Total entry commissions for this spread */
  readonly entryCommissions: number;
}

/** Iron condor = PCS + CCS pair on the same underlying / expiry. */
export interface IronCondor {
  readonly spreadType: 'IRON_CONDOR';
  readonly putSpread: Spread;
  readonly callSpread: Spread;
  readonly contracts: number;
  readonly totalCredit: number;
  readonly maxProfit: number;
  /** Max loss = wider wing width * 100 * contracts - totalCredit */
  readonly maxLoss: number;
  readonly riskRewardRatio: number;
  readonly breakevenLow: number;
  readonly breakevenHigh: number;
  readonly putWingWidth: number;
  readonly callWingWidth: number;
  /** Entry time from trade history, if matched */
  readonly entryTime: string | null;
}
