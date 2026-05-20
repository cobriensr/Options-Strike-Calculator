/**
 * Settlement-check result type, shared between `src/utils/settlement.ts`
 * (pure compute) and `src/components/SettlementCheck/` (UI rendering).
 *
 * Lifted from `src/components/SettlementCheck/types.ts` in Phase 3C to
 * fix the inverted dependency where a pure util was importing a type
 * from a UI component.
 */

export interface SettlementResult {
  delta: number;
  callStrike: number;
  putStrike: number;
  /** Never touched either strike intraday */
  survived: boolean;
  callBreached: boolean;
  putBreached: boolean;
  callCushion: number;
  putCushion: number;
  settlement: number;
  remainingHigh: number;
  remainingLow: number;
  /** Settlement price ended between strikes (max profit even if breached intraday) */
  settledSafe: boolean;
}
