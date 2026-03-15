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
