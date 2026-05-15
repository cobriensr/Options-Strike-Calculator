/**
 * Opening Flow Signal — V4 rule evaluation.
 *
 * Pure functions that take raw ws_option_trades rows for one ticker
 * and return slice-1/slice-2 aggregates + signal decision. Kept
 * dependency-free so the endpoint can stay thin and tests can drive
 * any scenario without hitting Postgres.
 *
 * Rule (proven by 91-day backtest + 31-day OOS walk-forward, see
 * docs/tmp/spy-opening-flow/FINDINGS_V5_WALKFORWARD.md):
 *
 *   1. Group slice-1 (09:30–09:35 ET) trades by (strike, option_type),
 *      sum premium, keep tickets with premium >= $1M.
 *   2. Bias side = side with more total premium across qualifying tickets.
 *   3. Top-3 same side: the 3 largest tickets by premium must all be on
 *      the bias side.
 *   4. Slice-2 confirm: across ALL slice-2 (09:35–09:40 ET) trades
 *      (not just $1M+ tickets), bias-side premium share must be >= 60%.
 *   5. Contract = highest-volume bias-side $1M+ ticket.
 *      (Test winner: +1.45 R_stop30 vs +1.24 for largest-premium.)
 */

export interface RawTrade {
  /** ISO timestamp (ws_option_trades.executed_at). */
  executedAt: string | Date;
  /** Strike price. */
  strike: number;
  /** 'C' or 'P' (ws_option_trades.option_type uses CHAR(1)). */
  optionTypeChar: 'C' | 'P';
  /** Trade price per share. */
  price: number;
  /** Contracts. */
  size: number;
}

export interface Ticket {
  strike: number;
  side: 'call' | 'put';
  premium: number;
  volume: number;
  avgFill: number;
}

export interface Slice1Result {
  tickets: Ticket[];
  callPremium: number;
  putPremium: number;
  biasSide: 'call' | 'put' | null;
  biasRatio: number;
  top3SameSide: boolean;
}

export interface Slice2Result {
  totalPremium: number;
  biasPremium: number;
  biasShare: number | null;
  confirms: boolean;
}

export type SignalReason =
  | 'no_tickets'
  | 'top3_mixed'
  | 's2_below_60'
  | 'window_not_complete';

export interface SignalFired {
  fired: true;
  side: 'call' | 'put';
  contract: Ticket;
  /** Slice-1 avg fill (price per share) — the entry reference. */
  entryPrice: number;
}

export interface SignalBlocked {
  fired: false;
  reason: SignalReason;
}

export type SignalResult = SignalFired | SignalBlocked;

const TICKET_MIN_PREMIUM = 1_000_000;
const SLICE2_CONFIRM_THRESHOLD = 0.6;

function sideOf(t: RawTrade): 'call' | 'put' {
  return t.optionTypeChar === 'C' ? 'call' : 'put';
}

/**
 * Aggregate slice-1 trades into $1M+ tickets and compute bias state.
 * Returns null if there are no qualifying tickets.
 */
export function evaluateSlice1(trades: readonly RawTrade[]): Slice1Result {
  const map = new Map<
    string,
    {
      strike: number;
      side: 'call' | 'put';
      premium: number;
      volume: number;
      pxSize: number;
    }
  >();

  for (const t of trades) {
    const side = sideOf(t);
    const key = `${t.strike}|${side}`;
    let agg = map.get(key);
    if (!agg) {
      agg = { strike: t.strike, side, premium: 0, volume: 0, pxSize: 0 };
      map.set(key, agg);
    }
    // Cash premium = price × size × 100 (per OPRA contract multiplier).
    agg.premium += t.price * t.size * 100;
    agg.volume += t.size;
    agg.pxSize += t.price * t.size;
  }

  const tickets: Ticket[] = [...map.values()]
    .filter((a) => a.premium >= TICKET_MIN_PREMIUM)
    .map((a) => ({
      strike: a.strike,
      side: a.side,
      premium: a.premium,
      volume: a.volume,
      avgFill: a.volume > 0 ? a.pxSize / a.volume : 0,
    }))
    .sort((a, b) => b.premium - a.premium);

  const callPremium = tickets
    .filter((t) => t.side === 'call')
    .reduce((s, t) => s + t.premium, 0);
  const putPremium = tickets
    .filter((t) => t.side === 'put')
    .reduce((s, t) => s + t.premium, 0);
  const totalPremium = callPremium + putPremium;

  const biasSide: 'call' | 'put' | null =
    totalPremium === 0 ? null : callPremium >= putPremium ? 'call' : 'put';
  const biasRatio =
    totalPremium === 0 ? 0 : Math.max(callPremium, putPremium) / totalPremium;

  const top3 = tickets.slice(0, 3);
  const top3SameSide =
    top3.length === 3 &&
    biasSide !== null &&
    top3.every((t) => t.side === biasSide);

  return {
    tickets,
    callPremium,
    putPremium,
    biasSide,
    biasRatio,
    top3SameSide,
  };
}

/**
 * Aggregate slice-2 trades to test the >=60% bias-side share confirm.
 * Operates on ALL slice-2 trades regardless of strike-level premium
 * (this is what the backtest measured — see bulk_v4_exits.py s2 math).
 */
export function evaluateSlice2(
  trades: readonly RawTrade[],
  biasSide: 'call' | 'put',
): Slice2Result {
  let callPremium = 0;
  let putPremium = 0;
  for (const t of trades) {
    const prem = t.price * t.size * 100;
    if (sideOf(t) === 'call') callPremium += prem;
    else putPremium += prem;
  }
  const totalPremium = callPremium + putPremium;
  const biasPremium = biasSide === 'call' ? callPremium : putPremium;
  const biasShare = totalPremium > 0 ? biasPremium / totalPremium : null;
  const confirms = biasShare != null && biasShare >= SLICE2_CONFIRM_THRESHOLD;
  return { totalPremium, biasPremium, biasShare, confirms };
}

/**
 * Pick the contract to trade: highest-volume bias-side $1M+ ticket.
 * Returns null if no bias-side tickets are present.
 */
export function pickContract(
  tickets: readonly Ticket[],
  biasSide: 'call' | 'put',
): Ticket | null {
  const biasTickets = tickets.filter((t) => t.side === biasSide);
  if (biasTickets.length === 0) return null;
  return [...biasTickets].sort((a, b) => b.volume - a.volume)[0]!;
}

/**
 * Full V4 rule evaluation. `slice2Complete=false` means slice 2 is
 * still in progress — we report whatever we have but don't fire.
 */
export function evaluateRule(args: {
  slice1Trades: readonly RawTrade[];
  slice2Trades: readonly RawTrade[];
  slice2Complete: boolean;
}): {
  slice1: Slice1Result;
  slice2: Slice2Result | null;
  signal: SignalResult;
} {
  const slice1 = evaluateSlice1(args.slice1Trades);

  if (slice1.tickets.length === 0 || slice1.biasSide === null) {
    return {
      slice1,
      slice2: null,
      signal: { fired: false, reason: 'no_tickets' },
    };
  }

  const slice2 = evaluateSlice2(args.slice2Trades, slice1.biasSide);

  if (!args.slice2Complete) {
    return {
      slice1,
      slice2,
      signal: { fired: false, reason: 'window_not_complete' },
    };
  }

  if (!slice1.top3SameSide) {
    return { slice1, slice2, signal: { fired: false, reason: 'top3_mixed' } };
  }

  if (!slice2.confirms) {
    return { slice1, slice2, signal: { fired: false, reason: 's2_below_60' } };
  }

  const contract = pickContract(slice1.tickets, slice1.biasSide);
  if (contract === null) {
    return { slice1, slice2, signal: { fired: false, reason: 'no_tickets' } };
  }

  return {
    slice1,
    slice2,
    signal: {
      fired: true,
      side: slice1.biasSide,
      contract,
      entryPrice: contract.avgFill,
    },
  };
}

export const OPENING_FLOW_CONSTANTS = {
  TICKET_MIN_PREMIUM,
  SLICE2_CONFIRM_THRESHOLD,
  STOP_LOSS_PCT: 0.3,
  EXIT_MINUTES_FROM_ENTRY: 60,
} as const;
