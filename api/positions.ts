/**
 * GET /api/positions
 *   Fetches the trader's current SPX 0DTE positions from Schwab,
 *   filters for today's expiring SPX options, groups into spreads,
 *   generates a human-readable summary for Claude analysis context,
 *   and saves to the positions table.
 *
 *   Query params:
 *     ?date=2026-03-16  (optional, defaults to today ET)
 *
 * POST /api/positions
 *   Accepts a thinkorswim paperMoney CSV account statement export.
 *   Parses all sections (Options, Trade History, P&L, Account Summary)
 *   to build a complete picture of open positions + closed trades today.
 *
 *   Body: raw CSV text (Content-Type: text/plain or application/json with { csv: "..." })
 *
 * Both return:
 *   { positions: { summary, legs, spreads, stats }, saved: boolean }
 */
import { Sentry, metrics } from './_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  rejectIfRateLimited,
  schwabTraderFetch,
  guardOwnerEndpoint,
} from './_lib/api-helpers.js';
import { savePositions, getDb, type PositionLeg } from './_lib/db.js';
import logger from './_lib/logger.js';
import { parseFullCSV, buildFullSummary } from './_lib/csv-parser.js';
import { positionCsvSchema } from './_lib/validation.js';
import { getETDateStr } from '../src/utils/timezone.js';

// Re-export for any external consumers
export { parseTosExpiration } from './_lib/csv-parser.js';

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
  return getETDateStr(new Date());
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
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let i = 0; i < longs.length; i++) {
        if (usedLongs.has(i)) continue;
        const leg = longs[i]!;
        const dist = Math.abs(leg.strike - short.strike);
        if (dist < bestDist && dist <= 50) {
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
          type,
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
 * Generate a human-readable summary string for the Schwab GET path.
 * The CSV POST path uses buildFullSummary from csv-parser.ts instead.
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
// SHARED RESPONSE BUILDER
// ============================================================
function buildPositionResponse(spxLegs: PositionLeg[], spxPrice?: number) {
  const spreads = groupIntoSpreads(spxLegs);
  const callSpreads = spreads.filter((s) => s.type === 'CALL CREDIT SPREAD');
  const putSpreads = spreads.filter((s) => s.type === 'PUT CREDIT SPREAD');
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

  return {
    summary,
    spreads,
    callSpreadsCount: callSpreads.length,
    putSpreadsCount: putSpreads.length,
    totalPnl,
    totalCredit,
    totalValue,
    netDelta,
    netTheta,
    netGamma,
  };
}

// ============================================================
// HANDLER
// ============================================================
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const done = metrics.request('/api/positions');
  if (req.method !== 'GET' && req.method !== 'POST') {
    done({ status: 405 });
    return res.status(405).json({ error: 'GET or POST only' });
  }
  const rejected = await guardOwnerEndpoint(req, res, done);
  if (rejected) return;
  const rateLimited = await rejectIfRateLimited(req, res, 'positions', 20);
  if (rateLimited) {
    done({ status: 429 });
    return;
  }
  const today = (req.query.date as string) || getTodayET();
  const fetchTime = getNowCT();
  if (req.method === 'POST') {
    return handleCSVUpload(req, res, today, fetchTime);
  }
  return handleSchwabFetch(req, res, today, fetchTime);
}

// ============================================================
// POST — CSV upload from thinkorswim paperMoney
// ============================================================
async function handleCSVUpload(
  req: VercelRequest,
  res: VercelResponse,
  today: string,
  fetchTime: string,
) {
  try {
    const rawCsv =
      typeof req.body === 'string'
        ? req.body
        : typeof req.body?.csv === 'string'
          ? req.body.csv
          : null;
    if (rawCsv === null) {
      return res.status(400).json({
        error: 'Request body must be CSV text or JSON { csv: "..." }',
      });
    }

    const validation = positionCsvSchema.safeParse({ csv: rawCsv });
    if (!validation.success) {
      const tooLarge = validation.error.issues.some((i) =>
        i.message.includes('too large'),
      );
      return res.status(tooLarge ? 413 : 400).json({
        error: 'Invalid CSV payload',
        issues: validation.error.issues,
      });
    }
    const csv = validation.data.csv;
    if (!csv.trim()) {
      return res.status(400).json({ error: 'Empty CSV body' });
    }

    // Parse all sections of the CSV holistically
    const parsed = parseFullCSV(csv);

    // Open legs from Options section (or derived from Trade History fallback)
    const spxLegs = parsed.openLegs;

    if (spxLegs.length === 0 && parsed.allTrades.length === 0) {
      return res.status(400).json({
        error:
          'No SPX options found in CSV. Ensure the file contains an "Options" or "Account Trade History" section with SPX trades.',
      });
    }

    const spxPrice = req.query.spx
      ? Number.parseFloat(req.query.spx as string)
      : undefined;

    // Build spread stats from open legs
    const r = buildPositionResponse(spxLegs, spxPrice);

    // Override summary with the full version (includes open + closed + account)
    const fullSummary = buildFullSummary(parsed, spxPrice);

    // Find matching snapshot
    const db = getDb();
    const snapRows = await db`
      SELECT id FROM market_snapshots WHERE date = ${today} ORDER BY created_at DESC LIMIT 1
    `;
    const snapshotId =
      snapRows.length > 0 ? ((snapRows[0]?.id as number) ?? null) : null;

    // Save to DB
    let saved = false;
    try {
      await savePositions({
        date: today,
        fetchTime,
        accountHash: 'paperMoney',
        spxPrice,
        summary: fullSummary,
        legs: spxLegs,
        totalSpreads: r.spreads.length,
        callSpreads: r.callSpreadsCount,
        putSpreads: r.putSpreadsCount,
        netDelta: r.netDelta || undefined,
        netTheta: r.netTheta || undefined,
        netGamma: r.netGamma || undefined,
        totalCredit: r.totalCredit || undefined,
        currentValue: r.totalValue || undefined,
        unrealizedPnl: r.totalPnl || undefined,
        snapshotId,
      });
      saved = true;
      metrics.dbSave('positions', true);
    } catch (error_) {
      metrics.dbSave('positions', false);
      logger.error({ err: error_ }, 'Failed to save uploaded positions');
    }

    return res.status(200).json({
      positions: {
        summary: fullSummary,
        legs: spxLegs,
        spreads: r.spreads,
        closedToday: parsed.closedSpreads,
        stats: {
          totalSpreads: r.spreads.length,
          callSpreads: r.callSpreadsCount,
          putSpreads: r.putSpreadsCount,
          netDelta: r.netDelta,
          netTheta: r.netTheta,
          netGamma: r.netGamma,
          totalCredit: r.totalCredit,
          currentValue: r.totalValue,
          unrealizedPnl: r.totalPnl,
          dayPnl: parsed.dayPnl,
          ytdPnl: parsed.ytdPnl,
          netLiquidatingValue: parsed.netLiquidatingValue,
        },
      },
      saved,
      fetchTime,
      source: 'paperMoney',
    });
  } catch (err) {
    Sentry.captureException(err);
    logger.error({ err }, 'CSV upload error');
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to parse CSV',
    });
  }
}

// ============================================================
// GET — live Schwab Trader API fetch
// ============================================================
async function handleSchwabFetch(
  req: VercelRequest,
  res: VercelResponse,
  today: string,
  fetchTime: string,
) {
  try {
    const acctResult = await schwabTraderFetch<SchwabAccountNumber[]>(
      '/accounts/accountNumbers',
    );
    if (!acctResult.ok) {
      return res.status(acctResult.status).json({ error: acctResult.error });
    }
    if (!acctResult.data || acctResult.data.length === 0) {
      return res.status(404).json({ error: 'No linked accounts found' });
    }
    const accountHash = acctResult.data[0]!.hashValue;

    const posResult = await schwabTraderFetch<SchwabAccount>(
      `/accounts/${accountHash}?fields=positions`,
    );
    if (!posResult.ok) {
      return res.status(posResult.status).json({ error: posResult.error });
    }
    const positions = posResult.data?.securitiesAccount?.positions ?? [];

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
          delta: undefined,
          theta: undefined,
          gamma: undefined,
        });
      }
    }

    const spxPrice = req.query.spx
      ? Number.parseFloat(req.query.spx as string)
      : undefined;
    const r = buildPositionResponse(spxLegs, spxPrice);

    const db = getDb();
    const snapRows = await db`
      SELECT id FROM market_snapshots WHERE date = ${today} ORDER BY created_at DESC LIMIT 1
    `;
    const snapshotId =
      snapRows.length > 0 ? ((snapRows[0]?.id as number) ?? null) : null;

    let saved = false;
    try {
      await savePositions({
        date: today,
        fetchTime,
        accountHash,
        spxPrice,
        summary: r.summary,
        legs: spxLegs,
        totalSpreads: r.spreads.length,
        callSpreads: r.callSpreadsCount,
        putSpreads: r.putSpreadsCount,
        netDelta: r.netDelta || undefined,
        netTheta: r.netTheta || undefined,
        netGamma: r.netGamma || undefined,
        totalCredit: r.totalCredit || undefined,
        currentValue: r.totalValue || undefined,
        unrealizedPnl: r.totalPnl || undefined,
        snapshotId,
      });
      saved = true;
      metrics.dbSave('positions', true);
    } catch (error_) {
      metrics.dbSave('positions', false);
      logger.error({ err: error_ }, 'Failed to save positions');
    }

    return res.status(200).json({
      positions: {
        summary: r.summary,
        legs: spxLegs,
        spreads: r.spreads,
        stats: {
          totalSpreads: r.spreads.length,
          callSpreads: r.callSpreadsCount,
          putSpreads: r.putSpreadsCount,
          netDelta: r.netDelta,
          netTheta: r.netTheta,
          netGamma: r.netGamma,
          totalCredit: r.totalCredit,
          currentValue: r.totalValue,
          unrealizedPnl: r.totalPnl,
        },
      },
      saved,
      fetchTime,
    });
  } catch (err) {
    Sentry.captureException(err);
    logger.error({ err }, 'Positions fetch error');
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to fetch positions',
    });
  }
}
