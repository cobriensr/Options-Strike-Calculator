/**
 * Pure math for the Futures P&L Calculator.
 *
 * CME contract specs (from exchange spec sheet):
 *   ES: $50/point, 0.25 tick / $12.50 tick value, day margin $500/contract
 *   NQ: $20/point, 0.25 tick / $5.00  tick value, day margin $1,000/contract
 *
 * Fees per contract per side:
 *   Exchange $1.38 + NFA $0.02 + Clearing $0.19 = $1.59
 *   Round-trip: $3.18 per contract
 */

export type FuturesSymbol = 'ES' | 'NQ';
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
  },
};

/** Per-side commission for a given number of contracts. */
export function feesPerSide(spec: ContractSpec, contracts: number): number {
  return (spec.exchangeFee + spec.nfaFee + spec.clearingFee) * contracts;
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
