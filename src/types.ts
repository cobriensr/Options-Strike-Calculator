/** Valid delta targets for which we have z-scores */
export type DeltaTarget = 5 | 8 | 10 | 12 | 15 | 20;

/** IV input modes */
export type IVMode = 'vix' | 'direct';

/** Result of market time validation */
export interface TimeValidation {
  readonly valid: boolean;
  readonly error?: string;
  readonly hoursRemaining?: number;
}

/** IV resolution input when using VIX mode */
export interface VIXInput {
  readonly vix: number;
  readonly multiplier: number;
}

/** IV resolution input when using direct mode */
export interface DirectIVInput {
  readonly directIV: number;
}

/** Result of IV resolution */
export interface IVResult {
  readonly sigma: number | null;
  readonly error?: string;
}

/** Strike calculation result for a single delta */
export interface StrikeResult {
  readonly putStrike: number;
  readonly callStrike: number;
  readonly putStrikeSnapped: number;
  readonly callStrikeSnapped: number;
}

/** Error result for strike calculation */
export interface StrikeError {
  readonly error: string;
}

/** Full delta row with all derived data */
export interface DeltaRow {
  readonly delta: DeltaTarget;
  readonly z: number;
  readonly putStrike: number;
  readonly callStrike: number;
  readonly putSnapped: number;
  readonly callSnapped: number;
  readonly putSpySnapped: number;
  readonly callSpySnapped: number;
  readonly spyPut: string;
  readonly spyCall: string;
  readonly putDistance: number;
  readonly callDistance: number;
  readonly putPct: string;
  readonly callPct: string;
  /** Theoretical put premium (per 1 share of underlying) */
  readonly putPremium: number;
  /** Theoretical call premium (per 1 share of underlying) */
  readonly callPremium: number;
  /** σ used for put (includes skew) */
  readonly putSigma: number;
  /** σ used for call (includes skew) */
  readonly callSigma: number;
}

/** Iron condor legs for a single delta */
export interface IronCondorLegs {
  readonly delta: DeltaTarget;
  readonly shortPut: number;
  readonly longPut: number;
  readonly shortCall: number;
  readonly longCall: number;
  readonly shortPutSpy: number;
  readonly longPutSpy: number;
  readonly shortCallSpy: number;
  readonly longCallSpy: number;
  readonly wingWidthSpx: number;
  /** Premium received for selling the short put */
  readonly shortPutPremium: number;
  /** Premium paid for buying the long put */
  readonly longPutPremium: number;
  /** Premium received for selling the short call */
  readonly shortCallPremium: number;
  /** Premium paid for buying the long call */
  readonly longCallPremium: number;
  /** Net credit received (short premiums - long premiums) */
  readonly creditReceived: number;
  /** Max profit = credit received */
  readonly maxProfit: number;
  /** Max loss per side = wing width - credit received */
  readonly maxLoss: number;
  /** Lower breakeven = short put - credit */
  readonly breakEvenLow: number;
  /** Upper breakeven = short call + credit */
  readonly breakEvenHigh: number;
  /** Return on risk = credit / max loss */
  readonly returnOnRisk: number;
  /** Probability of profit (price stays between breakevens) */
  readonly probabilityOfProfit: number;
  /** Put spread credit (short put premium - long put premium) */
  readonly putSpreadCredit: number;
  /** Call spread credit (short call premium - long call premium) */
  readonly callSpreadCredit: number;
  /** Put spread max loss = wing width - put credit */
  readonly putSpreadMaxLoss: number;
  /** Call spread max loss = wing width - call credit */
  readonly callSpreadMaxLoss: number;
  /** Put spread breakeven = short put - put credit */
  readonly putSpreadBE: number;
  /** Call spread breakeven = short call + call credit */
  readonly callSpreadBE: number;
  /** Put spread RoR = put credit / put max loss */
  readonly putSpreadRoR: number;
  /** Call spread RoR = call credit / call max loss */
  readonly callSpreadRoR: number;
  /** Put spread PoP = P(S_T > put BE) */
  readonly putSpreadPoP: number;
  /** Call spread PoP = P(S_T < call BE) */
  readonly callSpreadPoP: number;
}

/** Error delta row */
export interface DeltaRowError {
  readonly delta: DeltaTarget;
  readonly error: string;
}

/** VIX OHLC data for a single day */
export interface VIXDayData {
  readonly open: number | null;
  readonly high: number | null;
  readonly low: number | null;
  readonly close: number | null;
}

/** Map of date string -> VIX OHLC */
export type VIXDataMap = Record<string, VIXDayData>;

/** Full calculation results */
export interface CalculationResults {
  readonly allDeltas: ReadonlyArray<DeltaRow | DeltaRowError>;
  readonly sigma: number;
  readonly T: number;
  readonly hoursRemaining: number;
  readonly spot: number;
}
