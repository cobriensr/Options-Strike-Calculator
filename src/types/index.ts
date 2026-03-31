/** Traffic-light signal: green / yellow / red */
export type TrafficSignal = 'green' | 'yellow' | 'red';

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
  /** σ used for put pricing (includes skew + IV acceleration) */
  readonly putSigma: number;
  /** σ used for call pricing (includes skew + IV acceleration) */
  readonly callSigma: number;
  /** Base σ for put (skew only, no IV acceleration) — used for settlement PoP */
  readonly basePutSigma: number;
  /** Base σ for call (skew only, no IV acceleration) — used for settlement PoP */
  readonly baseCallSigma: number;
  /** Actual BS delta of the snapped put strike (absolute value, 0–1) */
  readonly putActualDelta: number;
  /** Actual BS delta of the snapped call strike (absolute value, 0–1) */
  readonly callActualDelta: number;
  /** Gamma of the snapped put strike (delta change per $1 SPX move) */
  readonly putGamma: number;
  /** Gamma of the snapped call strike (delta change per $1 SPX move) */
  readonly callGamma: number;
  /** Theta of the snapped put strike (annualized; divide by 252 for daily) */
  readonly putTheta: number;
  /** Theta of the snapped call strike (annualized; divide by 252 for daily) */
  readonly callTheta: number;
  /** IV acceleration multiplier applied to σ (1.0 at open, increases toward close) */
  readonly ivAccelMult: number;
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
  /** Fat-tail adjusted IC PoP (accounts for leptokurtic intraday returns) */
  readonly adjustedPoP: number;
  /** Fat-tail adjusted put spread PoP */
  readonly adjustedPutSpreadPoP: number;
  /** Fat-tail adjusted call spread PoP */
  readonly adjustedCallSpreadPoP: number;
}

/** Broken wing butterfly legs for a single delta (put or call side) */
export interface BWBLegs {
  readonly side: 'put' | 'call';
  readonly delta: DeltaTarget;
  /** Short strike (2× sold — the sweet spot) */
  readonly shortStrike: number;
  /** Long near wing (closer to money — defines credit side) */
  readonly longNearStrike: number;
  /** Long far wing (further OTM — defines max loss side) */
  readonly longFarStrike: number;
  /** SPY equivalents */
  readonly shortStrikeSpy: number;
  readonly longNearStrikeSpy: number;
  readonly longFarStrikeSpy: number;
  /** Narrow wing width (near side, pts) */
  readonly narrowWidth: number;
  /** Wide wing width (far side, pts) */
  readonly wideWidth: number;
  /** Premium for each short contract (×2 sold) */
  readonly shortPremium: number;
  /** Premium for the long near wing */
  readonly longNearPremium: number;
  /** Premium for the long far wing */
  readonly longFarPremium: number;
  /** Net credit received (positive = credit, negative = debit) */
  readonly netCredit: number;
  /** Max profit at sweet spot = narrowWidth + netCredit */
  readonly maxProfit: number;
  /** Max loss on wide side = wideWidth - narrowWidth - netCredit */
  readonly maxLoss: number;
  /** Breakeven level (SPX) */
  readonly breakeven: number;
  /** Sweet spot = short strike */
  readonly sweetSpot: number;
  /** Return on risk = netCredit / maxLoss (for credit trades) */
  readonly returnOnRisk: number;
  /** Probability of profit (log-normal) */
  readonly probabilityOfProfit: number;
  /** Fat-tail adjusted PoP */
  readonly adjustedPoP: number;
  /** Aggregate Greeks across all 3 legs (net of 1 long near, 2 short, 1 long far) */
  readonly netDelta: number;
  readonly netGamma: number;
  readonly netTheta: number;
  readonly netVega: number;
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
  /** VIX level (when available) — used for regime-dependent kurtosis */
  readonly vix?: number;
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
  /** Hedge DTE (days to expiration for the hedge options) */
  readonly hedgeDte: number;
  /** Raw 2Δ put strike */
  readonly putStrike: number;
  /** Raw 2Δ call strike */
  readonly callStrike: number;
  /** Snapped to nearest 5-pt increment */
  readonly putStrikeSnapped: number;
  /** Snapped to nearest 5-pt increment */
  readonly callStrikeSnapped: number;
  /** Theoretical put premium per contract (points, at hedge DTE) */
  readonly putPremium: number;
  /** Theoretical call premium per contract (points, at hedge DTE) */
  readonly callPremium: number;
  /** Estimated put recovery at EOD if OTM (points, at hedge DTE - 1 day) */
  readonly putRecovery: number;
  /** Estimated call recovery at EOD if OTM (points, at hedge DTE - 1 day) */
  readonly callRecovery: number;
  /** Recommended number of hedge put contracts */
  readonly recommendedPuts: number;
  /** Recommended number of hedge call contracts */
  readonly recommendedCalls: number;
  /** Net daily hedge cost in points (entry - EOD recovery) */
  readonly dailyCostPts: number;
  /** Net daily hedge cost in dollars (entry - EOD recovery) */
  readonly dailyCostDollars: number;
  /** SPX crash size (pts) where net P&L ≈ 0 with recommended puts */
  readonly breakEvenCrashPts: number;
  /** SPX rally size (pts) where net P&L ≈ 0 with recommended calls */
  readonly breakEvenRallyPts: number;
  /** IC credit minus net hedge cost in dollars */
  readonly netCreditAfterHedge: number;
  /** Vega of a single hedge put ($ change per 1% IV move) */
  readonly putVegaPer1Pct: number;
  /** Vega of a single hedge call ($ change per 1% IV move) */
  readonly callVegaPer1Pct: number;
  /** Total vega exposure of all hedge contracts ($ per 1% IV move) */
  readonly totalVegaPer1Pct: number;
  /** P&L scenarios at various crash/rally sizes */
  readonly scenarios: readonly HedgeScenario[];
}
