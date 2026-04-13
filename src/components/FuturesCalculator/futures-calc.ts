/**
 * Pure math for the Futures P&L Calculator.
 *
 * CME contract specs (from exchange spec sheet):
 *   ES: $50/point, 0.25 tick / $12.50 tick value, day margin $500/contract
 *   NQ: $20/point, 0.25 tick / $5.00  tick value, day margin $1,000/contract
 *
 * Fees per contract per side:
 *   Exchange $1.38 + NFA $0.02 + Clearing $0.19 + Broker commission $1.29 = $2.88
 *   Round-trip: $5.76 per contract
 */

export type FuturesSymbol = 'ES' | 'NQ' | 'MES' | 'MNQ';
export type Direction = 'long' | 'short';

export interface ContractSpec {
  readonly label: string;
  readonly name: string;
  readonly pointValue: number;
  readonly tickSize: number;
  readonly tickValue: number;
  readonly dayMargin: number;
  readonly exchangeFee: number;
  readonly nfaFee: number;
  readonly clearingFee: number;
  readonly brokerCommission: number;
}

export const SPECS: Record<FuturesSymbol, ContractSpec> = {
  ES: {
    label: '/ES',
    name: 'E-Mini S&P 500',
    pointValue: 50,
    tickSize: 0.25,
    tickValue: 12.5,
    dayMargin: 500,
    exchangeFee: 1.38,
    nfaFee: 0.02,
    clearingFee: 0.19,
    brokerCommission: 1.29,
  },
  NQ: {
    label: '/NQ',
    name: 'E-Mini NASDAQ 100',
    pointValue: 20,
    tickSize: 0.25,
    tickValue: 5.0,
    dayMargin: 1000,
    exchangeFee: 1.38,
    nfaFee: 0.02,
    clearingFee: 0.19,
    brokerCommission: 1.29,
  },
  MES: {
    label: '/MES',
    name: 'Micro E-Mini S&P 500',
    pointValue: 5,
    tickSize: 0.25,
    tickValue: 1.25,
    dayMargin: 50,
    exchangeFee: 0.35,
    nfaFee: 0.02,
    clearingFee: 0.19,
    brokerCommission: 0.95,
  },
  MNQ: {
    label: '/MNQ',
    name: 'Micro E-Mini NASDAQ 100',
    pointValue: 2,
    tickSize: 0.25,
    tickValue: 0.5,
    dayMargin: 100,
    exchangeFee: 0.35,
    nfaFee: 0.02,
    clearingFee: 0.19,
    brokerCommission: 0.95,
  },
};

/** Per-side cost for a given number of contracts (exchange + NFA + clearing + broker). */
export function feesPerSide(spec: ContractSpec, contracts: number): number {
  return (
    (spec.exchangeFee +
      spec.nfaFee +
      spec.clearingFee +
      spec.brokerCommission) *
    contracts
  );
}

/** Total round-trip commission (buy + sell). */
export function roundTripFees(spec: ContractSpec, contracts: number): number {
  return feesPerSide(spec, contracts) * 2;
}

/** Gross dollar P&L before commissions. */
export function grossPnl(
  spec: ContractSpec,
  entry: number,
  exit: number,
  direction: Direction,
  contracts: number,
): number {
  const pointDiff = direction === 'long' ? exit - entry : entry - exit;
  return pointDiff * spec.pointValue * contracts;
}

/** Net dollar P&L after round-trip commissions. */
export function netPnl(gross: number, fees: number): number {
  return gross - fees;
}

/**
 * Exit price at which the trade breaks even after round-trip fees.
 * The fee per contract is divided evenly across contracts — result is the
 * same regardless of contract count because margin, ticks, and fees all
 * scale linearly.
 */
export function breakEvenPrice(
  spec: ContractSpec,
  entry: number,
  direction: Direction,
  contracts: number,
): number {
  const feesInPoints =
    roundTripFees(spec, contracts) / spec.pointValue / contracts;
  return direction === 'long' ? entry + feesInPoints : entry - feesInPoints;
}

export interface TradeResult {
  readonly gross: number;
  readonly fees: number;
  readonly net: number;
  readonly points: number;
  readonly ticks: number;
  readonly marginRequired: number;
  readonly returnOnMarginPct: number;
}

/** Full trade calculation given both entry and exit. */
export function calcTrade(
  spec: ContractSpec,
  entry: number,
  exit: number,
  direction: Direction,
  contracts: number,
): TradeResult {
  const gross = grossPnl(spec, entry, exit, direction, contracts);
  const fees = roundTripFees(spec, contracts);
  const net = netPnl(gross, fees);
  const points = direction === 'long' ? exit - entry : entry - exit;
  const ticks = points / spec.tickSize;
  const marginRequired = spec.dayMargin * contracts;
  const returnOnMarginPct =
    marginRequired > 0 ? (net / marginRequired) * 100 : 0;
  return { gross, fees, net, points, ticks, marginRequired, returnOnMarginPct };
}

/**
 * Reward-to-risk ratio: how many points of reward per point of risk.
 * Returns 0 when the stop distance is zero (undefined risk).
 */
export function riskRewardRatio(
  entry: number,
  target: number,
  stop: number,
  direction: Direction,
): number {
  const rewardPts = direction === 'long' ? target - entry : entry - target;
  const riskPts = direction === 'long' ? entry - stop : stop - entry;
  if (riskPts <= 0) return 0;
  return rewardPts / riskPts;
}

/**
 * Maximum number of contracts tradeable within a dollar risk budget.
 * Risk per contract = (stop-distance × point-value) + round-trip fees.
 * Returns 0 when the stop distance is zero or the budget is insufficient.
 */
export function maxContractsFromRisk(
  spec: ContractSpec,
  entry: number,
  stop: number,
  direction: Direction,
  maxDollarRisk: number,
): number {
  const stopPts = direction === 'long' ? entry - stop : stop - entry;
  if (stopPts <= 0 || maxDollarRisk <= 0) return 0;
  const dollarRiskPerContract =
    stopPts * spec.pointValue + roundTripFees(spec, 1);
  return Math.max(0, Math.floor(maxDollarRisk / dollarRiskPerContract));
}

export interface TickRow {
  readonly ticks: number;
  readonly points: number;
  readonly exitPx: number;
  readonly gross: number;
  readonly net: number;
}

/** P&L at a given number of favorable ticks from entry. */
export function calcTickRow(
  spec: ContractSpec,
  entry: number,
  direction: Direction,
  contracts: number,
  ticks: number,
): TickRow {
  const points = ticks * spec.tickSize;
  const gross = points * spec.pointValue * contracts;
  const fees = roundTripFees(spec, contracts);
  const net = gross - fees;
  const exitPx = direction === 'long' ? entry + points : entry - points;
  return { ticks, points, exitPx, gross, net };
}
