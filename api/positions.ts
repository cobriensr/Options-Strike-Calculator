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
import {
  buildPositionResponse,
  type PositionResponse,
} from './_lib/positions-spreads.js';
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

// ============================================================
// SHARED PERSISTENCE
// ============================================================

/**
 * Persist a position snapshot to Postgres. Both handler entry points
 * (CSV upload and Schwab live fetch) share this routine — only the
 * summary string and accountHash differ per source.
 *
 * Returns `true` when the row was saved, `false` if savePositions threw
 * (the handler still responds 200 in that case so the trader sees their
 * stats — the DB write is incidental to the response).
 */
async function persistPositions(args: {
  date: string;
  fetchTime: string;
  accountHash: string;
  spxPrice?: number | undefined;
  summary: string;
  legs: PositionLeg[];
  response: PositionResponse;
}): Promise<boolean> {
  const { date, fetchTime, accountHash, spxPrice, summary, legs, response } =
    args;
  const db = getDb();
  const snapRows = await db`
    SELECT id FROM market_snapshots WHERE date = ${date} ORDER BY created_at DESC LIMIT 1
  `;
  const snapshotId =
    snapRows.length > 0 ? ((snapRows[0]?.id as number) ?? null) : null;

  try {
    await savePositions({
      date,
      fetchTime,
      accountHash,
      spxPrice,
      summary,
      legs,
      totalSpreads: response.spreads.length,
      callSpreads: response.callSpreadsCount,
      putSpreads: response.putSpreadsCount,
      netDelta: response.netDelta || undefined,
      netTheta: response.netTheta || undefined,
      netGamma: response.netGamma || undefined,
      totalCredit: response.totalCredit || undefined,
      currentValue: response.totalValue || undefined,
      unrealizedPnl: response.totalPnl || undefined,
      snapshotId,
    });
    metrics.dbSave('positions', true);
    return true;
  } catch (error_) {
    metrics.dbSave('positions', false);
    logger.error({ err: error_ }, 'Failed to save positions');
    return false;
  }
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

    const saved = await persistPositions({
      date: today,
      fetchTime,
      accountHash: 'paperMoney',
      spxPrice,
      summary: fullSummary,
      legs: spxLegs,
      response: r,
    });

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

    const saved = await persistPositions({
      date: today,
      fetchTime,
      accountHash,
      spxPrice,
      summary: r.summary,
      legs: spxLegs,
      response: r,
    });

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
