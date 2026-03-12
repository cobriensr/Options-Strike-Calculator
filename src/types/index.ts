/** Valid delta targets for which we have z-scores */
export type DeltaTarget = 5 | 8 | 10 | 12 | 15 | 20;

/** IV input modes */
export type IVMode = 'vix' | 'direct';

/** AM/PM selector */
export type AmPm = 'AM' | 'PM';

/** Timezone selector */
export type Timezone = 'ET' | 'CT';

/** OHLC field selector for VIX date lookup */
export type OHLCField = 'smart' | 'open' | 'high' | 'low' | 'close';

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
  /** Actual BS delta of the snapped put strike (absolute value, 0–1) */
  readonly putActualDelta: number;
  /** Actual BS delta of the snapped call strike (absolute value, 0–1) */
  readonly callActualDelta: number;
  /** Gamma of the snapped put strike (delta change per $1 SPX move) */
  readonly putGamma: number;
  /** Gamma of the snapped call strike (delta change per $1 SPX move) */
  readonly callGamma: number;
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

// ============================================================
// HEDGE CALCULATOR TYPES
// ============================================================

/** Valid hedge delta targets */
export type HedgeDelta = 1 | 2 | 3 | 5;

/** A single crash/rally scenario with full P&L breakdown */
export interface HedgeScenario {
  readonly movePoints: number;
  readonly movePct: string;
  readonly direction: 'crash' | 'rally';
  /** IC P&L in dollars (negative = loss) */
  readonly icPnL: number;
  /** Put hedge payout in dollars */
  readonly hedgePutPnL: number;
  /** Call hedge payout in dollars */
  readonly hedgeCallPnL: number;
  /** Total hedge cost in dollars (negative) */
  readonly hedgeCost: number;
  /** Net P&L across IC + hedge */
  readonly netPnL: number;
}

/** Complete hedge recommendation for a given IC position */
export interface HedgeResult {
  readonly hedgeDelta: HedgeDelta;
  /** Raw 2Δ put strike */
  readonly putStrike: number;
  /** Raw 2Δ call strike */
  readonly callStrike: number;
  /** Snapped to nearest 5-pt increment */
  readonly putStrikeSnapped: number;
  /** Snapped to nearest 5-pt increment */
  readonly callStrikeSnapped: number;
  /** Theoretical put premium per contract (points) */
  readonly putPremium: number;
  /** Theoretical call premium per contract (points) */
  readonly callPremium: number;
  /** Recommended number of hedge put contracts */
  readonly recommendedPuts: number;
  /** Recommended number of hedge call contracts */
  readonly recommendedCalls: number;
  /** Total daily hedge cost in points */
  readonly dailyCostPts: number;
  /** Total daily hedge cost in dollars */
  readonly dailyCostDollars: number;
  /** SPX crash size (pts) where net P&L ≈ 0 with recommended puts */
  readonly breakEvenCrashPts: number;
  /** SPX rally size (pts) where net P&L ≈ 0 with recommended calls */
  readonly breakEvenRallyPts: number;
  /** IC credit minus hedge cost in dollars */
  readonly netCreditAfterHedge: number;
  /** P&L scenarios at various crash/rally sizes */
  readonly scenarios: readonly HedgeScenario[];
}
