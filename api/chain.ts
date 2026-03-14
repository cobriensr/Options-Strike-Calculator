/**
 * GET /api/chain
 *
 * Returns the SPX 0DTE option chain with per-strike greeks from Schwab.
 * This gives exact broker-computed deltas, IVs, and premiums — solving
 * the single-σ model's inaccuracy on high-skew days.
 *
 * Query params:
 *   strikeCount — number of strikes around ATM (default 40 = ±20)
 *
 * Cache:
 *   Market hours: 30s edge cache + 15s SWR (chain moves fast)
 *   After hours:  300s edge cache + 60s SWR
 *
 * Response:
 * {
 *   underlying: { symbol, price, prevClose },
 *   expirationDate: "2026-03-13",
 *   daysToExpiration: 0,
 *   puts: [ { strike, bid, ask, mid, delta, gamma, theta, vega, iv, volume, oi } ],
 *   calls: [ { strike, bid, ask, mid, delta, gamma, theta, vega, iv, volume, oi } ],
 *   // Pre-computed: nearest strikes to target deltas
 *   targetDeltas: {
 *     5:  { putStrike, callStrike, putDelta, callDelta, putIV, callIV, putBid, callBid },
 *     8:  { ... },
 *     10: { ... },
 *     12: { ... },
 *     15: { ... },
 *     20: { ... },
 *   },
 *   asOf: ISO string
 * }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  schwabFetch,
  setCacheHeaders,
  isMarketOpen,
  rejectIfNotOwner,
} from './_lib/api-helpers.js';

// ============================================================
// SCHWAB CHAIN RESPONSE TYPES
// ============================================================

interface SchwabOptionContract {
  putCall: 'PUT' | 'CALL';
  symbol: string;
  description: string;
  bid: number;
  ask: number;
  last: number;
  mark: number;
  totalVolume: number;
  openInterest: number;
  strikePrice: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  volatility: number; // IV as percentage (e.g. 25.5 = 25.5%)
  daysToExpiration: number;
  inTheMoney: boolean;
  theoreticalValue: number;
  expirationDate: string;
}

interface SchwabChainResponse {
  symbol: string;
  status: string;
  underlying: {
    symbol: string;
    last: number;
    close: number;
    change: number;
  };
  isDelayed: boolean;
  numberOfContracts: number;
  // Keyed by "YYYY-MM-DD:DTE" then by strike price string
  putExpDateMap: Record<string, Record<string, SchwabOptionContract[]>>;
  callExpDateMap: Record<string, Record<string, SchwabOptionContract[]>>;
}

// ============================================================
// OUTPUT TYPES
// ============================================================

interface ChainStrike {
  strike: number;
  bid: number;
  ask: number;
  mid: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number; // as decimal (0.25 not 25)
  volume: number;
  oi: number;
  itm: boolean;
}

interface TargetDeltaMatch {
  putStrike: number;
  callStrike: number;
  putDelta: number;
  callDelta: number;
  putIV: number;
  callIV: number;
  putBid: number;
  putAsk: number;
  callBid: number;
  callAsk: number;
  putMid: number;
  callMid: number;
  icCredit: number; // put mid + call mid
  width: number; // call - put
}

// ============================================================
// HELPERS
// ============================================================

function getTodayET(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function flattenMap(
  expDateMap: Record<string, Record<string, SchwabOptionContract[]>>,
): SchwabOptionContract[] {
  const contracts: SchwabOptionContract[] = [];
  for (const dateKey of Object.keys(expDateMap)) {
    const strikes = expDateMap[dateKey]!;
    for (const strikeKey of Object.keys(strikes)) {
      const list = strikes[strikeKey]!;
      if (list.length > 0) contracts.push(list[0]!);
    }
  }
  // Sort by strike
  contracts.sort((a, b) => a.strikePrice - b.strikePrice);
  return contracts;
}

function toChainStrike(c: SchwabOptionContract): ChainStrike {
  return {
    strike: c.strikePrice,
    bid: c.bid,
    ask: c.ask,
    mid: Math.round(((c.bid + c.ask) / 2) * 100) / 100,
    delta: Math.round(c.delta * 10000) / 10000,
    gamma: Math.round(c.gamma * 10000) / 10000,
    theta: Math.round(c.theta * 100) / 100,
    vega: Math.round(c.vega * 100) / 100,
    iv: Math.round((c.volatility / 100) * 10000) / 10000, // pct → decimal
    volume: c.totalVolume,
    oi: c.openInterest,
    itm: c.inTheMoney,
  };
}

/**
 * Find the put strike closest to a target delta (OTM puts have negative delta).
 * Target: e.g. 5 means find the put with delta closest to -0.05.
 */
function findPutForDelta(
  puts: ChainStrike[],
  targetDelta: number,
): ChainStrike | null {
  const target = -targetDelta / 100; // e.g. 5 → -0.05
  let best: ChainStrike | null = null;
  let bestDist = Infinity;
  for (const p of puts) {
    if (p.delta >= 0) continue; // skip ITM puts (delta > 0 shouldn't happen for OTM)
    const dist = Math.abs(p.delta - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  return best;
}

/**
 * Find the call strike closest to a target delta (OTM calls have positive delta).
 * Target: e.g. 5 means find the call with delta closest to 0.05.
 */
function findCallForDelta(
  calls: ChainStrike[],
  targetDelta: number,
): ChainStrike | null {
  const target = targetDelta / 100; // e.g. 5 → 0.05
  let best: ChainStrike | null = null;
  let bestDist = Infinity;
  for (const c of calls) {
    if (c.delta <= 0) continue; // skip ITM calls
    const dist = Math.abs(c.delta - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  return best;
}

// ============================================================
// HANDLER
// ============================================================

const TARGET_DELTAS = [5, 8, 10, 12, 15, 20];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ownerCheck = rejectIfNotOwner(req, res);
  if (ownerCheck) return ownerCheck;

  const today = getTodayET();
  const strikeCount = Number(req.query.strikeCount) || 40;

  // Schwab uses $SPX for SPX options (SPXW weeklies for 0DTE)
  // First try today's expiration, then next available trading day
  const result = await schwabFetch<SchwabChainResponse>(
    `/chains?symbol=$SPX&contractType=ALL&includeUnderlyingQuote=true` +
    `&strategy=SINGLE&range=OTM&fromDate=${today}&toDate=${today}` +
    `&strikeCount=${strikeCount}`,
  );

  if ('error' in result) {
    return res.status(result.status).json({ error: result.error });
  }

  const chain = result.data;
  const rawPuts = flattenMap(chain.putExpDateMap ?? {});
  const rawCalls = flattenMap(chain.callExpDateMap ?? {});

  if (rawPuts.length === 0 && rawCalls.length === 0) {
    return res.status(200).json({
      error: 'No 0DTE contracts found. Market may be closed or chain not yet available.',
      underlying: chain.underlying ? {
        symbol: chain.underlying.symbol,
        price: chain.underlying.last,
        prevClose: chain.underlying.close,
      } : null,
      puts: [],
      calls: [],
      targetDeltas: {},
      asOf: new Date().toISOString(),
    });
  }

  return buildResponse(res, chain, rawPuts, rawCalls, today);
}

function buildResponse(
  res: VercelResponse,
  chain: SchwabChainResponse,
  rawPuts: SchwabOptionContract[],
  rawCalls: SchwabOptionContract[],
  today: string,
) {
  const puts = rawPuts.map(toChainStrike);
  const calls = rawCalls.map(toChainStrike);

  // Find the expiration date string (first key in either map)
  const expDate =
    Object.keys(chain.putExpDateMap)[0]?.split(':')[0] ??
    Object.keys(chain.callExpDateMap)[0]?.split(':')[0] ??
    today;

  // Match target deltas to actual chain strikes
  const targetDeltas: Record<number, TargetDeltaMatch> = {};

  for (const d of TARGET_DELTAS) {
    const putMatch = findPutForDelta(puts, d);
    const callMatch = findCallForDelta(calls, d);

    if (putMatch && callMatch) {
      targetDeltas[d] = {
        putStrike: putMatch.strike,
        callStrike: callMatch.strike,
        putDelta: putMatch.delta,
        callDelta: callMatch.delta,
        putIV: putMatch.iv,
        callIV: callMatch.iv,
        putBid: putMatch.bid,
        putAsk: putMatch.ask,
        callBid: callMatch.bid,
        callAsk: callMatch.ask,
        putMid: putMatch.mid,
        callMid: callMatch.mid,
        icCredit: Math.round((putMatch.mid + callMatch.mid) * 100) / 100,
        width: callMatch.strike - putMatch.strike,
      };
    }
  }

  // Cache: 30s during market, 5 min after
  const open = isMarketOpen();
  setCacheHeaders(res, open ? 30 : 300, open ? 15 : 60);

  return res.status(200).json({
    underlying: {
      symbol: chain.underlying?.symbol ?? '$SPX',
      price: chain.underlying?.last ?? 0,
      prevClose: chain.underlying?.close ?? 0,
    },
    expirationDate: expDate,
    daysToExpiration: 0,
    contractCount: puts.length + calls.length,
    puts,
    calls,
    targetDeltas,
    asOf: new Date().toISOString(),
  });
}