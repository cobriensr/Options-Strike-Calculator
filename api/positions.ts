/**
 * GET /api/positions
 *
 * Fetches the trader's current SPX 0DTE positions from Schwab,
 * filters for today's expiring SPX options, groups into spreads,
 * generates a human-readable summary for Claude analysis context,
 * and saves to the positions table.
 *
 * Query params:
 *   ?date=2026-03-16  (optional, defaults to today ET)
 *
 * Returns:
 *   { positions: { summary, legs, spreads, stats }, saved: boolean }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  rejectIfNotOwner,
  rejectIfRateLimited,
  schwabTraderFetch,
} from './_lib/api-helpers.js';
import { savePositions, getDb, type PositionLeg } from './_lib/db.js';
import logger from './_lib/logger.js';

// ============================================================
// TYPES for Schwab Trader API responses
// ============================================================

interface SchwabAccountNumber {
  accountNumber: string;
  hashValue: string;
}

interface SchwabPosition {
  shortQuantity: number;
  longQuantity: number;
  averagePrice: number;
  currentDayProfitLoss: number;
  currentDayProfitLossPercentage: number;
  marketValue: number;
  instrument: {
    assetType: string;
    cusip?: string;
    symbol: string;
    description?: string;
    putCall?: 'PUT' | 'CALL';
    underlyingSymbol?: string;
    strikePrice?: number;
    expirationDate?: string;
    type?: string;
  };
}

interface SchwabAccount {
  securitiesAccount: {
    accountNumber: string;
    type: string;
    positions?: SchwabPosition[];
    currentBalances?: {
      liquidationValue?: number;
      availableFunds?: number;
    };
  };
}

// ============================================================
// HELPERS
// ============================================================

/** Get today's date in ET as YYYY-MM-DD */
function getTodayET(): string {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  });
}

/** Get current time in CT as HH:MM */
function getNowCT(): string {
  return new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** Check if an expiration date string matches today */
function isExpiringToday(expirationDate: string, today: string): boolean {
  // Schwab returns dates like "2026-03-16T00:00:00.000+00:00" or just "2026-03-16"
  return expirationDate.startsWith(today);
}

interface Spread {
  type: 'CALL CREDIT SPREAD' | 'PUT CREDIT SPREAD' | 'IRON CONDOR' | 'SINGLE';
  shortLeg: PositionLeg;
  longLeg?: PositionLeg;
  credit: number;
  currentValue: number;
  pnl: number;
  pnlPct: number;
  width: number;
}

/**
 * Group individual option legs into credit spreads.
 * Matches short legs with long legs of the same type (put/call)
 * by finding the closest strikes.
 */
function groupIntoSpreads(legs: PositionLeg[]): Spread[] {
  const calls = legs.filter((l) => l.putCall === 'CALL');
  const puts = legs.filter((l) => l.putCall === 'PUT');
  const spreads: Spread[] = [];

  function pairLegs(group: PositionLeg[]): Spread[] {
    const shorts = group
      .filter((l) => l.quantity < 0)
      .sort((a, b) => a.strike - b.strike);
    const longs = group
      .filter((l) => l.quantity > 0)
      .sort((a, b) => a.strike - b.strike);
    const paired: Spread[] = [];
    const usedLongs = new Set<number>();

    for (const short of shorts) {
      // Find the closest long leg not yet paired
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let i = 0; i < longs.length; i++) {
        if (usedLongs.has(i)) continue;
        const leg = longs[i]!;
        const dist = Math.abs(leg.strike - short.strike);
        if (dist < bestDist && dist <= 50) {
          // max 50-pt wide spread
          bestDist = dist;
          bestIdx = i;
        }
      }

      if (bestIdx >= 0) {
        usedLongs.add(bestIdx);
        const long = longs[bestIdx]!;
        const credit =
          Math.abs(short.averagePrice) - Math.abs(long.averagePrice);
        const currentValue =
          Math.abs(short.marketValue) - Math.abs(long.marketValue);
        const pnl = credit * 100 * Math.abs(short.quantity) - currentValue;
        const width = Math.abs(long.strike - short.strike);
        const type =
          short.putCall === 'CALL' ? 'CALL CREDIT SPREAD' : 'PUT CREDIT SPREAD';

        paired.push({
          type: type as 'CALL CREDIT SPREAD' | 'PUT CREDIT SPREAD',
          shortLeg: short,
          longLeg: long,
          credit: Math.round(credit * 100) / 100,
          currentValue: Math.round(currentValue * 100) / 100,
          pnl: Math.round(pnl * 100) / 100,
          pnlPct:
            credit > 0
              ? Math.round(
                  (pnl / (credit * 100 * Math.abs(short.quantity))) * 10000,
                ) / 100
              : 0,
          width,
        });
      } else {
        // Unpaired short — treat as single
        paired.push({
          type: 'SINGLE',
          shortLeg: short,
          credit: Math.abs(short.averagePrice),
          currentValue: Math.abs(short.marketValue),
          pnl:
            Math.abs(short.averagePrice) * 100 * Math.abs(short.quantity) -
            Math.abs(short.marketValue),
          pnlPct: 0,
          width: 0,
        });
      }
    }
    return paired;
  }

  spreads.push(...pairLegs(calls), ...pairLegs(puts));

  return spreads;
}

/**
 * Generate a human-readable summary string for prompt injection.
 */
function buildSummary(
  spreads: Spread[],
  legs: PositionLeg[],
  spxPrice?: number,
): string {
  if (spreads.length === 0) return 'No open SPX 0DTE positions.';

  const callSpreads = spreads.filter((s) => s.type === 'CALL CREDIT SPREAD');
  const putSpreads = spreads.filter((s) => s.type === 'PUT CREDIT SPREAD');

  const lines: string[] = [];
  lines.push(
    `=== Open SPX 0DTE Positions (${spreads.length} spread${spreads.length > 1 ? 's' : ''}) ===`,
  );
  if (spxPrice) lines.push(`SPX at fetch time: ${spxPrice}`);
  lines.push('');

  if (callSpreads.length > 0) {
    lines.push(`CALL CREDIT SPREADS (${callSpreads.length}):`);
    for (const s of callSpreads) {
      const cushion = spxPrice
        ? Math.round(s.shortLeg.strike - spxPrice)
        : null;
      lines.push(
        `  Short ${s.shortLeg.strike}C / Long ${s.longLeg?.strike ?? '?'}C | ${Math.abs(s.shortLeg.quantity)} contracts | ` +
          `Credit: $${s.credit.toFixed(2)} | Width: ${s.width} pts` +
          (cushion != null ? ` | Cushion: ${cushion} pts above SPX` : '') +
          (s.shortLeg.delta != null
            ? ` | Delta: ${s.shortLeg.delta.toFixed(3)}`
            : ''),
      );
    }
    lines.push('');
  }

  if (putSpreads.length > 0) {
    lines.push(`PUT CREDIT SPREADS (${putSpreads.length}):`);
    for (const s of putSpreads) {
      const cushion = spxPrice
        ? Math.round(spxPrice - s.shortLeg.strike)
        : null;
      lines.push(
        `  Short ${s.shortLeg.strike}P / Long ${s.longLeg?.strike ?? '?'}P | ${Math.abs(s.shortLeg.quantity)} contracts | ` +
          `Credit: $${s.credit.toFixed(2)} | Width: ${s.width} pts` +
          (cushion != null ? ` | Cushion: ${cushion} pts below SPX` : '') +
          (s.shortLeg.delta != null
            ? ` | Delta: ${s.shortLeg.delta.toFixed(3)}`
            : ''),
      );
    }
    lines.push('');
  }

  // Aggregate stats
  const totalDelta = legs.reduce(
    (sum, l) => sum + (l.delta ?? 0) * l.quantity,
    0,
  );
  const totalTheta = legs.reduce(
    (sum, l) => sum + (l.theta ?? 0) * Math.abs(l.quantity),
    0,
  );
  const totalPnl = spreads.reduce((sum, s) => sum + s.pnl, 0);

  lines.push(
    'AGGREGATE:',
    `  Net delta: ${totalDelta.toFixed(3)} | Net theta: ${totalTheta.toFixed(2)}`,
    `  Total unrealized P&L: $${totalPnl.toFixed(2)}`,
  );

  // Key strikes for the analysis
  const shortCalls = callSpreads
    .map((s) => s.shortLeg.strike)
    .sort((a, b) => a - b);
  const shortPuts = putSpreads
    .map((s) => s.shortLeg.strike)
    .sort((a, b) => b - a);
  if (shortCalls.length > 0) {
    const nearest = shortCalls[0]!;
    lines.push(
      `  Nearest short call: ${nearest}` +
        (spxPrice ? ` (${Math.round(nearest - spxPrice)} pts above SPX)` : ''),
    );
  }
  if (shortPuts.length > 0) {
    const nearest = shortPuts[0]!;
    lines.push(
      `  Nearest short put: ${nearest}` +
        (spxPrice ? ` (${Math.round(spxPrice - nearest)} pts below SPX)` : ''),
    );
  }

  return lines.join('\n');
}

// ============================================================
// HANDLER
// ============================================================

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }

  const ownerCheck = rejectIfNotOwner(req, res);
  if (ownerCheck) return ownerCheck;

  const rateLimited = await rejectIfRateLimited(req, res, 'positions', 20);
  if (rateLimited) return;

  const today = (req.query.date as string) || getTodayET();
  const fetchTime = getNowCT();

  try {
    // 1. Get account numbers
    const acctResult = await schwabTraderFetch<SchwabAccountNumber[]>(
      '/accounts/accountNumbers',
    );
    if ('error' in acctResult) {
      return res.status(acctResult.status).json({ error: acctResult.error });
    }

    if (!acctResult.data || acctResult.data.length === 0) {
      return res.status(404).json({ error: 'No linked accounts found' });
    }

    const accountHash = acctResult.data[0]!.hashValue;

    // 2. Get positions for the first account
    const posResult = await schwabTraderFetch<SchwabAccount>(
      `/accounts/${accountHash}?fields=positions`,
    );
    if ('error' in posResult) {
      return res.status(posResult.status).json({ error: posResult.error });
    }

    const positions = posResult.data?.securitiesAccount?.positions ?? [];

    // 3. Filter for SPX 0DTE options expiring today
    const spxLegs: PositionLeg[] = [];
    for (const pos of positions) {
      const inst = pos.instrument;
      if (
        inst.assetType === 'OPTION' &&
        inst.underlyingSymbol === '$SPX' &&
        inst.expirationDate &&
        isExpiringToday(inst.expirationDate, today) &&
        inst.putCall &&
        inst.strikePrice != null
      ) {
        const qty = (pos.longQuantity || 0) - (pos.shortQuantity || 0);
        if (qty === 0) continue;

        spxLegs.push({
          putCall: inst.putCall,
          symbol: inst.symbol,
          strike: inst.strikePrice,
          expiration: inst.expirationDate.slice(0, 10),
          quantity: qty,
          averagePrice: pos.averagePrice,
          marketValue: pos.marketValue,
          // Greeks may not be in the positions response — they come from the chain
          delta: undefined,
          theta: undefined,
          gamma: undefined,
        });
      }
    }

    // 4. Group into spreads and build summary
    const spreads = groupIntoSpreads(spxLegs);
    const callSpreads = spreads.filter((s) => s.type === 'CALL CREDIT SPREAD');
    const putSpreads = spreads.filter((s) => s.type === 'PUT CREDIT SPREAD');

    // Get SPX price from query or leave undefined
    const spxPrice = req.query.spx
      ? Number.parseFloat(req.query.spx as string)
      : undefined;
    const summary = buildSummary(spreads, spxLegs, spxPrice);

    const totalPnl = spreads.reduce((sum, s) => sum + s.pnl, 0);
    const totalCredit = spreads.reduce(
      (sum, s) => sum + s.credit * 100 * Math.abs(s.shortLeg.quantity),
      0,
    );
    const totalValue = spreads.reduce((sum, s) => sum + s.currentValue, 0);
    const netDelta = spxLegs.reduce(
      (sum, l) => sum + (l.delta ?? 0) * l.quantity,
      0,
    );
    const netTheta = spxLegs.reduce(
      (sum, l) => sum + (l.theta ?? 0) * Math.abs(l.quantity),
      0,
    );
    const netGamma = spxLegs.reduce(
      (sum, l) => sum + (l.gamma ?? 0) * Math.abs(l.quantity),
      0,
    );

    // 5. Find matching snapshot
    const db = getDb();
    const snapRows = await db`
      SELECT id FROM market_snapshots WHERE date = ${today} ORDER BY created_at DESC LIMIT 1
    `;
    const snapshotId =
      snapRows.length > 0 ? ((snapRows[0]?.id as number) ?? null) : null;

    // 6. Save to DB
    let saved = false;
    try {
      await savePositions({
        date: today,
        fetchTime,
        accountHash,
        spxPrice,
        summary,
        legs: spxLegs,
        totalSpreads: spreads.length,
        callSpreads: callSpreads.length,
        putSpreads: putSpreads.length,
        netDelta: netDelta || undefined,
        netTheta: netTheta || undefined,
        netGamma: netGamma || undefined,
        totalCredit: totalCredit || undefined,
        currentValue: totalValue || undefined,
        unrealizedPnl: totalPnl || undefined,
        snapshotId,
      });
      saved = true;
    } catch (dbErr) {
      logger.error({ err: dbErr }, 'Failed to save positions');
    }

    return res.status(200).json({
      positions: {
        summary,
        legs: spxLegs,
        spreads,
        stats: {
          totalSpreads: spreads.length,
          callSpreads: callSpreads.length,
          putSpreads: putSpreads.length,
          netDelta,
          netTheta,
          netGamma,
          totalCredit,
          currentValue: totalValue,
          unrealizedPnl: totalPnl,
        },
      },
      saved,
      fetchTime,
    });
  } catch (err) {
    logger.error({ err }, 'Positions fetch error');
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to fetch positions',
    });
  }
}
