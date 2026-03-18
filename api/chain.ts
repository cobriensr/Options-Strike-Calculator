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

import { Sentry, metrics } from './_lib/sentry.js';
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
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  });
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
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/chain');
    const done = metrics.request('/api/chain');
    try {
      const ownerCheck = rejectIfNotOwner(req, res);
      if (ownerCheck) {
        done({ status: 401 });
        return ownerCheck;
      }

      const today = getTodayET();
      const strikeCount = Number(req.query.strikeCount) || 80;

      // Schwab uses $SPX for SPX options (SPXW weeklies for 0DTE)
      // range=ALL to avoid missing strikes near ATM on fast-moving days
      const result = await schwabFetch<SchwabChainResponse>(
        `/chains?symbol=$SPX&contractType=ALL&includeUnderlyingQuote=true` +
          `&strategy=SINGLE&range=ALL&fromDate=${today}&toDate=${today}` +
          `&strikeCount=${strikeCount}`,
      );

      if ('error' in result) {
        done({ status: result.status, error: 'schwab' });
        return res.status(result.status).json({ error: result.error });
      }

      const chain = result.data;
      const rawPuts = flattenMap(chain.putExpDateMap ?? {});
      const rawCalls = flattenMap(chain.callExpDateMap ?? {});

      if (rawPuts.length === 0 && rawCalls.length === 0) {
        done({ status: 200 });
        return res.status(200).json({
          error:
            'No 0DTE contracts found. Market may be closed or chain not yet available.',
          underlying: chain.underlying
            ? {
                symbol: chain.underlying.symbol,
                price: chain.underlying.last,
                prevClose: chain.underlying.close,
              }
            : null,
          puts: [],
          calls: [],
          targetDeltas: {},
          asOf: new Date().toISOString(),
        });
      }

      done({ status: 200 });
      return buildResponse(res, chain, rawPuts, rawCalls, today);
    } catch (error) {
      done({ status: 500, error: 'unhandled' });
      Sentry.captureException(error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}

/**
 * Calculates max pain strike and pin risk metrics.
 *
 * Max pain = the strike where total option holder payout (OI × intrinsic) is minimized.
 * This is the price at which market makers lose the least, so MMs have incentive
 * to pin price near this level — especially in the final 90 minutes of 0DTE.
 *
 * Also returns the top OI strikes on each side (put/call walls).
 */
function calcMaxPain(
  puts: ChainStrike[],
  calls: ChainStrike[],
  currentPrice: number,
): {
  maxPainStrike: number;
  maxPainDistance: number;
  maxPainDistancePct: string;
  topPutOI: { strike: number; oi: number }[];
  topCallOI: { strike: number; oi: number }[];
} | null {
  // Collect all unique strikes
  const strikeSet = new Set<number>();
  for (const p of puts) strikeSet.add(p.strike);
  for (const c of calls) strikeSet.add(c.strike);

  const strikes = [...strikeSet].sort((a, b) => a - b);
  if (strikes.length === 0) return null;

  // Build OI maps
  const putOI = new Map<number, number>();
  const callOI = new Map<number, number>();
  for (const p of puts) putOI.set(p.strike, (putOI.get(p.strike) ?? 0) + p.oi);
  for (const c of calls)
    callOI.set(c.strike, (callOI.get(c.strike) ?? 0) + c.oi);

  // For each candidate settlement price, compute total payout
  let minPayout = Infinity;
  let maxPainStrike = strikes[0]!;

  for (const settlement of strikes) {
    let totalPayout = 0;
    // Put holders get paid when settlement < strike
    for (const [strike, oi] of putOI) {
      if (settlement < strike) totalPayout += (strike - settlement) * oi;
    }
    // Call holders get paid when settlement > strike
    for (const [strike, oi] of callOI) {
      if (settlement > strike) totalPayout += (settlement - strike) * oi;
    }
    if (totalPayout < minPayout) {
      minPayout = totalPayout;
      maxPainStrike = settlement;
    }
  }

  // Top 3 OI strikes on each side (put/call walls)
  const putEntries = [...putOI.entries()]
    .filter(([, oi]) => oi > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([strike, oi]) => ({ strike, oi }));
  const callEntries = [...callOI.entries()]
    .filter(([, oi]) => oi > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([strike, oi]) => ({ strike, oi }));

  const distance = Math.abs(currentPrice - maxPainStrike);
  return {
    maxPainStrike,
    maxPainDistance: Math.round(distance),
    maxPainDistancePct: ((distance / currentPrice) * 100).toFixed(2),
    topPutOI: putEntries,
    topCallOI: callEntries,
  };
}

function buildResponse(
  res: VercelResponse,
  chain: SchwabChainResponse,
  rawPuts: SchwabOptionContract[],
  rawCalls: SchwabOptionContract[],
  today: string,
) {
  // Filter stale quotes: bid=0 or extremely wide spread (>50% of mid)
  const isLiveQuote = (s: ChainStrike): boolean => {
    if (s.bid <= 0) return false;
    if (s.mid > 0 && (s.ask - s.bid) / s.mid > 0.5) return false;
    return true;
  };

  const allPuts = rawPuts.map(toChainStrike);
  const allCalls = rawCalls.map(toChainStrike);
  const puts = allPuts.filter(isLiveQuote);
  const calls = allCalls.filter(isLiveQuote);

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

  // Max pain: the strike where total OI-weighted intrinsic payout is minimized
  // (the strike at which option writers lose the least money at expiration)
  // Max pain uses all strikes (including stale) since OI matters regardless of quote quality
  const pinRisk = calcMaxPain(allPuts, allCalls, chain.underlying?.last ?? 0);

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
    pinRisk,
    asOf: new Date().toISOString(),
  });
}
