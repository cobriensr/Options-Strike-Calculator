/**
 * GET /api/positions
 *   Fetches the trader's current SPX 0DTE positions from Schwab,
 *   filters for today's expiring SPX options, groups into spreads,
 *   generates a human-readable summary for Claude analysis context,
 *   and saves to the positions table.
 *
 *   Query params:
 *     ?date=2026-03-16  (optional, defaults to today ET)
 *     ?readonly=1       (optional; any other value is a 400, see below)
 *
 *   Read-only mode (?readonly=1) saves nothing. It answers from the date's
 *   newest paperMoney CSV upload when there is one (source 'paperMoney', the
 *   upload's fetchTime, no Schwab call), otherwise from Schwab (source
 *   'schwab'). Either way the legs are only those expiring on the date, and
 *   the body is built with no ?spx=. A failed CSV read is a 503 or 500, never
 *   a fall back to Schwab. A CSV with no open legs still governs. Why: a
 *   plain GET saves a row keyed by (date, CT minute), and a polling reader
 *   that saved would overwrite an upload and change what analyze reads.
 *
 * POST /api/positions
 *   Accepts a thinkorswim paperMoney CSV account statement export.
 *   Parses all sections (Options, Trade History, P&L, Account Summary)
 *   to build a complete picture of open positions + closed trades today.
 *
 *   Body: raw CSV text (Content-Type: text/plain or application/json with { csv: "..." })
 *   Ignores ?readonly=: a CSV upload always saves.
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
import {
  savePositions,
  getLatestCsvPositions,
  getDb,
  withDbRetry,
  safeDb,
  type PositionLeg,
} from './_lib/db.js';
import logger from './_lib/logger.js';
import { sendDbErrorResponse } from './_lib/transient-db-response.js';
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

/**
 * Parse the optional `?spx=` query param into a finite SPX price, or
 * `undefined` when absent or non-finite (NaN/Infinity from a malformed
 * value). Guards downstream distance/P&L math from poisoned inputs.
 */
function parseSpxQuery(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : undefined;
}

// ============================================================
// SHARED PERSISTENCE
// ============================================================

/**
 * Persist a position snapshot to Postgres. Both handler entry points
 * (CSV upload and Schwab live fetch) share this routine — only the
 * summary string and accountHash differ per source.
 *
 * Returns `true` when the row was written, `false` when savePositions threw
 * or returned null (its conflict guard skipped the update because a Schwab
 * save met a paperMoney row in the same minute). The handler still responds
 * 200 in both cases so the trader sees their stats — the DB write is
 * incidental to the response.
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
  // Optional FK enrichment. A transient Neon failure here must NOT 500 the
  // position read — soft-degrade snapshotId to null and still save the row.
  const snapshotId = await safeDb(async () => {
    const snapRows = await withDbRetry(
      () => db`
      SELECT id FROM market_snapshots WHERE date = ${date} ORDER BY created_at DESC LIMIT 1
    `,
      2,
      10_000,
    );
    return snapRows.length > 0 ? ((snapRows[0]?.id as number) ?? null) : null;
  }, null);

  try {
    const savedId = await savePositions({
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
    // A skipped write is not a failed save: the call succeeded.
    metrics.dbSave('positions', true);
    return savedId !== null;
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
  const rawDate = req.query.date;
  if (rawDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(rawDate as string)) {
    done({ status: 400 });
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }
  const today = (rawDate as string) || getTodayET();
  const fetchTime = getNowCT();
  if (req.method === 'POST') {
    // A CSV upload always saves: the flag is read on GET only.
    return handleCSVUpload(req, res, today, fetchTime, done);
  }
  // `1` turns the read-only mode on; anything else present is a 400, so a typo
  // can't fall through to a read that saves.
  const rawReadonly = req.query.readonly;
  if (rawReadonly !== undefined && rawReadonly !== '1') {
    done({ status: 400 });
    return res.status(400).json({ error: 'readonly must be 1' });
  }
  if (rawReadonly === '1') {
    return handleReadonlyFetch(res, today, fetchTime, done);
  }
  return handleSchwabFetch(req, res, today, fetchTime, done);
}

type RequestDone = (opts?: { status?: number; error?: string }) => void;

// ============================================================
// POST — CSV upload from thinkorswim paperMoney
// ============================================================
async function handleCSVUpload(
  req: VercelRequest,
  res: VercelResponse,
  today: string,
  fetchTime: string,
  done: RequestDone,
) {
  try {
    const rawCsv =
      typeof req.body === 'string'
        ? req.body
        : typeof req.body?.csv === 'string'
          ? req.body.csv
          : null;
    if (rawCsv === null) {
      done({ status: 400 });
      return res.status(400).json({
        error: 'Request body must be CSV text or JSON { csv: "..." }',
      });
    }

    const validation = positionCsvSchema.safeParse({ csv: rawCsv });
    if (!validation.success) {
      const tooLarge = validation.error.issues.some((i) =>
        i.message.includes('too large'),
      );
      const status = tooLarge ? 413 : 400;
      done({ status });
      return res.status(status).json({
        error: 'Invalid CSV payload',
        issues: validation.error.issues,
      });
    }
    const csv = validation.data.csv;
    if (!csv.trim()) {
      done({ status: 400 });
      return res.status(400).json({ error: 'Empty CSV body' });
    }

    // Parse all sections of the CSV holistically
    const parsed = parseFullCSV(csv);

    // Open legs from Options section (or derived from Trade History fallback)
    const spxLegs = parsed.openLegs;

    if (spxLegs.length === 0 && parsed.allTrades.length === 0) {
      done({ status: 400 });
      return res.status(400).json({
        error:
          'No SPX options found in CSV. Ensure the file contains an "Options" or "Account Trade History" section with SPX trades.',
      });
    }

    const spxPrice = parseSpxQuery(req.query.spx);

    // Build spread stats from open legs
    const r = buildPositionResponse(spxLegs, spxPrice);

    // Override summary with the full version (includes open + closed + account)
    const fullSummary = buildFullSummary(parsed, spxPrice);

    const saved = await persistPositions({
      date: today,
      fetchTime,
      // The marker savePositions' guard and getLatestCsvPositions key on
      // (PAPER_MONEY_ACCOUNT_HASH in db-positions.ts).
      accountHash: 'paperMoney',
      spxPrice,
      summary: fullSummary,
      legs: spxLegs,
      response: r,
    });

    const result = res.status(200).json({
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
    done({ status: 200 });
    return result;
  } catch (err) {
    Sentry.captureException(err);
    logger.error({ err }, 'CSV upload error');
    done({ status: 500, error: 'csv_parse_error' });
    return res.status(500).json({ error: 'Failed to parse CSV' });
  }
}

// ============================================================
// GET — shared pieces of the Schwab read and the read-only mode
// ============================================================

type SchwabLegsResult =
  | { ok: true; accountHash: string; legs: PositionLeg[] }
  | { ok: false; status: number; error: string };

/**
 * Today's SPX option legs from the live Schwab account: one account-list
 * call, then one positions call. A Schwab failure comes back as
 * `{ ok: false, status, error }` (a 401 means the login lapsed) for the
 * caller to pass through; a thrown error is left to the caller's catch.
 */
async function fetchSchwabLegs(today: string): Promise<SchwabLegsResult> {
  const acctResult = await schwabTraderFetch<SchwabAccountNumber[]>(
    '/accounts/accountNumbers',
  );
  if (!acctResult.ok) {
    return {
      ok: false,
      status: acctResult.status,
      error: acctResult.error,
    };
  }
  if (!acctResult.data || acctResult.data.length === 0) {
    return { ok: false, status: 404, error: 'No linked accounts found' };
  }
  const accountHash = acctResult.data[0]!.hashValue;

  const posResult = await schwabTraderFetch<SchwabAccount>(
    `/accounts/${accountHash}?fields=positions`,
  );
  if (!posResult.ok) {
    return {
      ok: false,
      status: posResult.status,
      error: posResult.error,
    };
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
  return { ok: true, accountHash, legs: spxLegs };
}

/** The `positions` object of the plain GET's answer, shared with read-only. */
function livePositionsBody(r: PositionResponse, legs: PositionLeg[]) {
  return {
    summary: r.summary,
    legs,
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
  };
}

/**
 * The GET catch: a transient Neon blip is a 503, anything else an opaque 500
 * that goes to Sentry. `done` is passed through so the request metric records
 * the status actually sent, not a guessed 500.
 */
function sendPositionsReadError(
  res: VercelResponse,
  err: unknown,
  done: RequestDone,
) {
  sendDbErrorResponse(res, err, {
    label: 'positions',
    serverErrorBody: { error: 'Failed to fetch positions' },
    done,
  });
}

// ============================================================
// GET — live Schwab Trader API fetch (saves a row)
// ============================================================
async function handleSchwabFetch(
  req: VercelRequest,
  res: VercelResponse,
  today: string,
  fetchTime: string,
  done: RequestDone,
) {
  try {
    const schwab = await fetchSchwabLegs(today);
    if (!schwab.ok) {
      done({ status: schwab.status });
      return res.status(schwab.status).json({ error: schwab.error });
    }
    const { accountHash, legs: spxLegs } = schwab;

    const spxPrice = parseSpxQuery(req.query.spx);
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

    const result = res.status(200).json({
      positions: livePositionsBody(r, spxLegs),
      saved,
      fetchTime,
    });
    done({ status: 200 });
    return result;
  } catch (err) {
    sendPositionsReadError(res, err, done);
    return;
  }
}

// ============================================================
// GET ?readonly=1 — today's CSV, else Schwab; saves nothing
// ============================================================
async function handleReadonlyFetch(
  res: VercelResponse,
  today: string,
  fetchTime: string,
  done: RequestDone,
) {
  try {
    // The CSV read comes first and its failure is an error, not a fall back
    // to Schwab: falling back would silently switch the source on a database
    // blip.
    const csv = await getLatestCsvPositions(today);
    if (csv) {
      // Same rule as the Schwab path's filter, so only today's legs stand.
      const legs = csv.legs.filter((leg) =>
        isExpiringToday(leg.expiration, today),
      );
      const r = buildPositionResponse(legs);
      const result = res.status(200).json({
        positions: livePositionsBody(r, legs),
        saved: false,
        fetchTime: csv.fetchTime,
        source: 'paperMoney',
      });
      done({ status: 200 });
      return result;
    }

    const schwab = await fetchSchwabLegs(today);
    if (!schwab.ok) {
      done({ status: schwab.status });
      return res.status(schwab.status).json({ error: schwab.error });
    }
    const r = buildPositionResponse(schwab.legs);
    const result = res.status(200).json({
      positions: livePositionsBody(r, schwab.legs),
      saved: false,
      fetchTime,
      source: 'schwab',
    });
    done({ status: 200 });
    return result;
  } catch (err) {
    sendPositionsReadError(res, err, done);
    return;
  }
}
