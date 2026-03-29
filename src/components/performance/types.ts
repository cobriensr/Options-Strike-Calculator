/**
 * Types for the paper trading performance dashboard.
 *
 * Covers the full parsed data model from a single-day
 * thinkorswim paperMoney account statement CSV export.
 */

// ── Section 1: Cash Balance ────────────────────────────────

/** Single row from the Cash Balance section */
export interface CashEntry {
  readonly date: string;
  readonly time: string;
  readonly type: 'BAL' | 'TRD' | 'EXP' | 'LIQ';
  readonly refNumber: string | null;
  readonly description: string;
  readonly miscFees: number;
  readonly commissions: number;
  readonly amount: number;
  readonly balance: number;
}

/** Parsed fields from a TRD description string */
export interface TrdDescription {
  readonly direction: 'SOLD' | 'BOT';
  readonly quantity: number;
  readonly spreadType: string;
  readonly symbol: string;
  readonly multiplier: number;
  readonly expiryLabel: string;
  readonly expiration: string;
  readonly strikes: string;
  readonly optionType: 'CALL' | 'PUT';
  readonly fillPrice: number;
}

// ── Section 2: Account Order History ───────────────────────

/** A single leg within an order */
export interface OrderLeg {
  readonly side: 'SELL' | 'BUY';
  readonly qty: number;
  readonly posEffect: 'TO OPEN' | 'TO CLOSE';
  readonly symbol: string;
  readonly exp: string;
  readonly strike: number;
  readonly type: 'CALL' | 'PUT';
}

/** Order status as reported by thinkorswim */
export type OrderStatus =
  | 'FILLED'
  | 'CANCELED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'WORKING'
  | string;

/** A single order from Account Order History */
export interface OrderEntry {
  readonly notes: string;
  readonly timePlaced: string;
  readonly spread: string;
  readonly legs: readonly OrderLeg[];
  readonly price: number;
  readonly orderType: string;
  readonly tif: string;
  readonly status: OrderStatus;
  readonly statusDetail: string;
  readonly isReplacement: boolean;
}

// ── Section 3: Account Trade History ───────────────────────

/** A single leg within an executed trade */
export interface TradeLeg {
  readonly side: 'SELL' | 'BUY';
  readonly qty: number;
  readonly posEffect: 'TO OPEN' | 'TO CLOSE';
  readonly symbol: string;
  readonly exp: string;
  readonly strike: number;
  readonly type: 'CALL' | 'PUT';
  readonly price: number;
  readonly creditDebit: 'CREDIT' | 'DEBIT' | null;
}

/** A single executed trade (may have multiple legs) */
export interface ExecutedTrade {
  readonly execTime: string;
  readonly spread: string;
  readonly legs: readonly TradeLeg[];
  readonly netPrice: number;
  readonly orderType: string;
}

// ── Section 4: Options (Open Positions) ────────────────────

/** A single open option leg from the Options section */
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

// ── Section 5: Profits and Losses ──────────────────────────

/** P&L row from the Profits and Losses section */
export interface PnLEntry {
  readonly symbol: string;
  readonly description: string;
  readonly plOpen: number;
  readonly plPct: number;
  readonly plDay: number;
  readonly plYtd: number;
  readonly plDiff: number;
  readonly marginReq: number;
  readonly markValue: number;
}

/** Full P&L summary (includes totals row) */
export interface PnLSummary {
  readonly entries: readonly PnLEntry[];
  readonly totals: PnLEntry | null;
}

// ── Section 6: Account Summary ─────────────────────────────

export interface AccountSummary {
  readonly netLiquidatingValue: number;
  readonly stockBuyingPower: number;
  readonly optionBuyingPower: number;
  readonly equityCommissionsYtd: number;
}

// ── Grouped Positions ──────────────────────────────────────

export type SpreadType =
  | 'PUT_CREDIT_SPREAD'
  | 'CALL_CREDIT_SPREAD'
  | 'IRON_CONDOR';

/** A grouped vertical spread (PCS or CCS) */
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

/** Iron condor = PCS + CCS pair */
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

/** A long option held as a hedge */
export interface HedgePosition {
  readonly leg: OpenLeg;
  /** Direction of the hedge position */
  readonly direction: 'LONG' | 'SHORT';
  /** The option type of the hedge leg */
  readonly protectionSide: 'CALL' | 'PUT';
  /** The hedge leg's strike */
  readonly strikeProtected: number;
  readonly contracts: number;
  readonly entryCost: number;
  readonly currentValue: number | null;
  /** currentValue - entryCost if mark present */
  readonly openPnl: number | null;
}

/** An unmatched short option (naked — high risk) */
export interface NakedPosition {
  readonly leg: OpenLeg;
  readonly contracts: number;
  readonly type: 'CALL' | 'PUT';
}

// ── Closed Spreads ─────────────────────────────────────────

/** Outcome classification for a closed spread */
export type ClosedSpreadOutcome =
  | 'FULL_PROFIT'
  | 'PARTIAL_PROFIT'
  | 'LOSS'
  | 'SCRATCH';

/** A spread that was opened and closed on the same day */
export interface ClosedSpread {
  readonly spreadType: SpreadType;
  readonly shortStrike: number;
  readonly longStrike: number;
  readonly optionType: 'CALL' | 'PUT';
  readonly contracts: number;
  readonly wingWidth: number;
  readonly openCredit: number;
  readonly closeDebit: number;
  readonly realizedPnl: number;
  readonly openTime: string;
  readonly closeTime: string;
  /** realizedPnl / maxLoss */
  readonly returnOnRisk: number;
  /** realizedPnl / openCredit * 100 */
  readonly creditCapturedPct: number;
  /** Minutes between open and close, if both times present */
  readonly holdTimeMinutes: number | null;
  /** Outcome based on realizedPnl vs openCredit */
  readonly outcome: ClosedSpreadOutcome;
}

// ── Portfolio Risk ──────────────────────────────────────────

export interface PortfolioRisk {
  /** Sum of max loss for all CCS + IC call-side contributions */
  readonly callSideRisk: number;
  /** Sum of max loss for all PCS + IC put-side contributions */
  readonly putSideRisk: number;
  /** Value of call-side hedges (entry cost) */
  readonly callHedgeValue: number;
  /** Value of put-side hedges (entry cost) */
  readonly putHedgeValue: number;
  /** callSideRisk - callHedgeValue */
  readonly netCallRisk: number;
  /** putSideRisk - putHedgeValue */
  readonly netPutRisk: number;
  /**
   * Conservative total max loss:
   * max(netPutRisk, netCallRisk)
   * ICs can only lose on one side, but standalone verticals
   * add independent risk to their respective side.
   */
  readonly totalMaxLoss: number;
  /** Total credit received from all open positions */
  readonly totalCredit: number;
  /** Total number of open contracts (all types) */
  readonly totalContracts: number;
  /** SPX spot price used for distance calculations */
  readonly spotPrice: number;
  /** Distance from spot to nearest short strike (points) */
  readonly nearestShortStrikeDistance: number;
  /** Number of naked shorts (should be 0 for defined risk) */
  readonly nakedCount: number;
  /** Lowest short put strike - total put credit per contract */
  readonly breakevenLow: number | null;
  /** Highest short call strike + total call credit per contract */
  readonly breakevenHigh: number | null;
  /** NLV - optionBuyingPower */
  readonly buyingPowerUsed: number;
  /** From AccountSummary.optionBuyingPower */
  readonly buyingPowerAvailable: number;
  /** buyingPowerUsed / NLV */
  readonly buyingPowerUtilization: number;
  /** Whether buying power can absorb total max loss */
  readonly canAbsorbMaxLoss: boolean;
  /** Largest single spread maxLoss / totalMaxLoss */
  readonly concentration: number;
}

// ── Execution Quality ──────────────────────────────────────

export interface SlippageEntry {
  readonly orderTime: string;
  readonly fillTime: string;
  readonly symbol: string;
  readonly strike: number;
  readonly type: 'CALL' | 'PUT';
  readonly spread: string;
  /** Limit price from the order */
  readonly limitPrice: number;
  /** Actual fill net price */
  readonly fillPrice: number;
  /** fillPrice - limitPrice: negative = favorable */
  readonly slippage: number;
  readonly contracts: number;
}

export interface RejectionReason {
  readonly reason: string;
  readonly count: number;
}

export interface ExecutionQuality {
  readonly fills: readonly SlippageEntry[];
  readonly averageSlippage: number;
  readonly totalSlippageDollars: number;
  readonly fillRate: number;
  readonly rejectedOrders: number;
  readonly canceledOrders: number;
  readonly replacementChains: number;
  /** rejectedOrders / totalOrders */
  readonly rejectionRate: number;
  /** canceledOrders / totalOrders */
  readonly cancellationRate: number;
  /** Grouped rejection reasons from order statusDetail */
  readonly rejectionReasons: readonly RejectionReason[];
  /** Earliest trade execution time */
  readonly firstTradeTime: string | null;
  /** Latest trade execution time */
  readonly lastTradeTime: string | null;
  /** Minutes between first and last trade */
  readonly tradingSessionMinutes: number | null;
  /** Number of trades per hour in the session */
  readonly tradesPerHour: number | null;
}

// ── Data Quality Warnings ──────────────────────────────────

export type WarningCode =
  | 'MISSING_MARK'
  | 'UNMATCHED_SHORT'
  | 'BALANCE_DISCONTINUITY'
  | 'MISSING_SECTION'
  | 'PNL_MISMATCH'
  | 'PAPER_TRADING';

export type WarningSeverity = 'info' | 'warn' | 'error';

export interface DataQualityWarning {
  readonly code: WarningCode;
  readonly severity: WarningSeverity;
  readonly message: string;
  readonly detail?: string;
}

// ── Top-Level Parsed Result ────────────────────────────────

/** Complete parsed result from a single-day statement CSV */
export interface DailyStatement {
  /** ISO date string (YYYY-MM-DD) for this statement */
  readonly date: string;

  // Raw parsed sections
  readonly cashEntries: readonly CashEntry[];
  readonly orders: readonly OrderEntry[];
  readonly trades: readonly ExecutedTrade[];
  readonly openLegs: readonly OpenLeg[];
  readonly pnl: PnLSummary;
  readonly accountSummary: AccountSummary;

  // Grouped positions
  readonly spreads: readonly Spread[];
  readonly ironCondors: readonly IronCondor[];
  readonly hedges: readonly HedgePosition[];
  readonly nakedPositions: readonly NakedPosition[];
  readonly closedSpreads: readonly ClosedSpread[];

  // Computed analytics
  readonly portfolioRisk: PortfolioRisk;
  readonly executionQuality: ExecutionQuality;
  readonly warnings: readonly DataQualityWarning[];
}
