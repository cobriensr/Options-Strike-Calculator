/**
 * GET /api/cron/fetch-strike-iv
 *
 * 1-minute cron that snapshots per-strike implied volatility for SPX, SPY,
 * and QQQ into the `strike_iv_snapshots` table. Foundation for the Strike
 * IV Anomaly Detector (Phase 2 layers detection + context capture on top).
 *
 * Per ticker, per run:
 *   1. Fetch the Schwab option chain for today → next 2 Fridays.
 *   2. Filter to OTM ±3% of spot.
 *   3. Filter to min OI (500 SPX, 250 SPY/QQQ).
 *   4. Recompute IV from bid/ask/mid price via Black-Scholes — Schwab's
 *      quoted IV may use a different forward/model, and recomputing keeps
 *      the cross-ticker time series consistent.
 *   5. Batch-insert one row per strike × expiry × side into
 *      strike_iv_snapshots.
 *
 * Fault tolerance: a Schwab auth or fetch failure for one ticker must NOT
 * block the other two. Each ticker runs independently and its errors are
 * captured to Sentry but not rethrown to the handler.
 *
 * Cron cadence: `* 13-21 * * 1-5` — every minute during market hours.
 * Volume budget: 3 tickers × 1 request/min = 180 Schwab requests/hour,
 * well under the per-app rate limit.
 *
 * Environment: CRON_SECRET (no UW API key — pure Schwab + Neon).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { cronGuard, schwabFetch } from '../_lib/api-helpers.js';
import {
  STRIKE_IV_OTM_RANGE_PCT,
  STRIKE_IV_MIN_OI_SPX,
  STRIKE_IV_MIN_OI_SPY_QQQ,
  STRIKE_IV_TICKERS,
  type StrikeIVTicker,
} from '../_lib/constants.js';
import { impliedVolatility } from '../../src/utils/black-scholes.js';

// ── Schwab types (duplicated locally — api/chain.ts is an endpoint, not a
//    reusable module, and extracting a shared helper is out of scope for
//    Phase 1). Only include the fields we actually read.
// ────────────────────────────────────────────────────────────

interface SchwabOptionContract {
  putCall: 'PUT' | 'CALL';
  bid: number;
  ask: number;
  mark: number;
  totalVolume: number;
  openInterest: number;
  strikePrice: number;
  daysToExpiration: number;
  expirationDate: string; // ISO "YYYY-MM-DDTHH:mm:ss..."
}

interface SchwabChainResponse {
  symbol: string;
  status: string;
  underlying: {
    symbol: string;
    last: number;
    close: number;
  };
  putExpDateMap: Record<string, Record<string, SchwabOptionContract[]>>;
  callExpDateMap: Record<string, Record<string, SchwabOptionContract[]>>;
}

// ── Row payload for a single insert ──────────────────────────

interface SnapshotRow {
  ticker: StrikeIVTicker;
  strike: number;
  side: 'call' | 'put';
  expiry: string; // YYYY-MM-DD
  spot: number;
  ivMid: number | null;
  ivBid: number | null;
  ivAsk: number | null;
  midPrice: number;
  oi: number;
  volume: number;
}

// ── Date / expiry helpers ────────────────────────────────────

/**
 * Given an ISO date string (YYYY-MM-DD), return the next N Fridays
 * (including today if today IS a Friday). Used to bound the Schwab
 * chain fetch to 0DTE + 2 near-dated Friday expiries.
 */
function nextFridays(fromDate: string, count: number): string[] {
  const [y, m, d] = fromDate.split('-').map(Number);
  if (y == null || m == null || d == null) return [];
  const out: string[] = [];
  const cursor = new Date(Date.UTC(y, m - 1, d));
  // Walk forward until we've collected `count` Fridays.
  for (let i = 0; i < 30 && out.length < count; i += 1) {
    if (cursor.getUTCDay() === 5) {
      out.push(cursor.toISOString().slice(0, 10));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/**
 * Build the sorted, deduped list of expiries we snapshot for: today (0DTE)
 * followed by the next 2 Fridays after today. If today IS a Friday, today
 * doubles as the first "next Friday" so we end up with exactly [today,
 * next Friday, Friday-after-that].
 */
function buildExpirySet(today: string): string[] {
  const fridays = nextFridays(today, 3);
  const set = new Set<string>([today, ...fridays]);
  return [...set].sort();
}

/**
 * Parse "YYYY-MM-DD:DTE" key from Schwab's {put,call}ExpDateMap into just
 * the date portion. Schwab sometimes returns the raw date with no DTE
 * suffix on ITM-exercised maps — handle both shapes defensively.
 */
function parseExpKey(key: string): string {
  const colon = key.indexOf(':');
  return colon === -1 ? key : key.slice(0, colon);
}

// ── Schwab chain fetch ───────────────────────────────────────

/**
 * Schwab uses a `$`-prefixed symbol for SPX options and bare symbols for
 * SPY/QQQ. See api/chain.ts for the established pattern.
 */
function schwabSymbol(ticker: StrikeIVTicker): string {
  return ticker === 'SPX' ? '$SPX' : ticker;
}

function minOiFor(ticker: StrikeIVTicker): number {
  return ticker === 'SPX' ? STRIKE_IV_MIN_OI_SPX : STRIKE_IV_MIN_OI_SPY_QQQ;
}

async function fetchChain(
  ticker: StrikeIVTicker,
  fromDate: string,
  toDate: string,
): Promise<SchwabChainResponse | null> {
  const symbol = encodeURIComponent(schwabSymbol(ticker));
  // `strategy=SINGLE&range=ALL&strikeCount=500` pulls the full strike ladder
  // across the date window — we filter to the ±3% OTM band downstream.
  const path =
    `/chains?symbol=${symbol}&contractType=ALL&includeUnderlyingQuote=true` +
    `&strategy=SINGLE&range=ALL` +
    `&fromDate=${fromDate}&toDate=${toDate}&strikeCount=500`;
  const result = await schwabFetch<SchwabChainResponse>(path);
  if (!result.ok) {
    logger.warn(
      { ticker, status: result.status, error: result.error },
      'fetch-strike-iv: Schwab chain fetch failed',
    );
    return null;
  }
  return result.data;
}

// ── Row extraction (per ticker) ──────────────────────────────

/**
 * Convert the nested {put,call}ExpDateMap → flat array of per-strike rows
 * filtered to the allowed expiries, OTM ±3% band, and min OI for the
 * ticker. IV is recomputed from bid/ask/mid prices via Black-Scholes and
 * may be null when the solver can't invert a stale quote.
 */
function extractRows(
  chain: SchwabChainResponse,
  ticker: StrikeIVTicker,
  allowedExpiries: Set<string>,
  nowMs: number,
): SnapshotRow[] {
  const spot = chain.underlying?.last;
  if (!Number.isFinite(spot) || spot <= 0) return [];

  const lowerBound = spot * (1 - STRIKE_IV_OTM_RANGE_PCT);
  const upperBound = spot * (1 + STRIKE_IV_OTM_RANGE_PCT);
  const minOi = minOiFor(ticker);
  const rows: SnapshotRow[] = [];

  for (const [side, map] of [
    ['call', chain.callExpDateMap ?? {}] as const,
    ['put', chain.putExpDateMap ?? {}] as const,
  ]) {
    for (const expKey of Object.keys(map)) {
      const expiry = parseExpKey(expKey);
      if (!allowedExpiries.has(expiry)) continue;

      const strikesMap = map[expKey]!;
      for (const strikeKey of Object.keys(strikesMap)) {
        const contracts = strikesMap[strikeKey]!;
        if (contracts.length === 0) continue;
        const c = contracts[0]!;

        const strike = c.strikePrice;
        if (!Number.isFinite(strike)) continue;

        // OTM gate: strict sense of "out of the money" for the given side.
        //   calls: strike > spot
        //   puts:  strike < spot
        // Plus the ±3% band.
        if (side === 'call' && strike <= spot) continue;
        if (side === 'put' && strike >= spot) continue;
        if (strike < lowerBound || strike > upperBound) continue;

        // Min OI gate. Treat NaN as 0 (illiquid).
        const oi = Number.isFinite(c.openInterest) ? c.openInterest : 0;
        if (oi < minOi) continue;

        // Prices must form a valid bid ≤ mid ≤ ask with a positive mid.
        const bid = Number.isFinite(c.bid) ? c.bid : 0;
        const ask = Number.isFinite(c.ask) ? c.ask : 0;
        if (bid <= 0 || ask <= 0 || ask < bid) continue;
        const mid = (bid + ask) / 2;
        if (mid <= 0) continue;

        // Time-to-expiry in YEARS. Use end-of-day UTC on expiry as proxy for
        // the 4:00 PM ET settlement — near enough for IV inversion at the
        // ±3% OTM band where vega is well-behaved. (For a 0DTE snapshot
        // at 10:00 ET this gives T ≈ 6h/8760h ≈ 0.00068 — the solver
        // handles this regime cleanly down to its tail guards.)
        const expiryMs = Date.parse(`${expiry}T21:00:00Z`);
        if (!Number.isFinite(expiryMs)) continue;
        const T = Math.max(expiryMs - nowMs, 60_000) / (365 * 24 * 3600 * 1000);

        const ivMid = impliedVolatility(mid, spot, strike, T, side);
        const ivBid = impliedVolatility(bid, spot, strike, T, side);
        const ivAsk = impliedVolatility(ask, spot, strike, T, side);

        // Drop the row entirely if the mid-IV doesn't invert — the anomaly
        // detector keys off iv_mid, so a row without it is noise. bid/ask
        // legs can still be null (wider tolerance) and we let the schema
        // nullability handle that.
        if (ivMid == null || !Number.isFinite(ivMid) || ivMid <= 0) {
          logger.warn(
            { ticker, strike, side, expiry, bid, ask, mid, spot, T },
            'fetch-strike-iv: mid IV inversion failed — skipping strike',
          );
          continue;
        }

        rows.push({
          ticker,
          strike,
          side,
          expiry,
          spot,
          ivMid,
          ivBid: ivBid != null && Number.isFinite(ivBid) ? ivBid : null,
          ivAsk: ivAsk != null && Number.isFinite(ivAsk) ? ivAsk : null,
          midPrice: mid,
          oi,
          volume: Number.isFinite(c.totalVolume) ? c.totalVolume : 0,
        });
      }
    }
  }

  return rows;
}

// ── DB insert ────────────────────────────────────────────────

async function insertRows(
  sql: ReturnType<typeof getDb>,
  rows: SnapshotRow[],
): Promise<number> {
  if (rows.length === 0) return 0;

  // One transaction per ticker; each row inserted via a tagged template
  // call inside the transaction so Neon builds the parameterized query
  // correctly. Follows the same shape as fetch-strike-exposure.
  const results = await sql.transaction((txn) =>
    rows.map(
      (row) => txn`
        INSERT INTO strike_iv_snapshots (
          ticker, strike, side, expiry, spot,
          iv_mid, iv_bid, iv_ask,
          mid_price, oi, volume
        )
        VALUES (
          ${row.ticker}, ${row.strike}, ${row.side}, ${row.expiry}, ${row.spot},
          ${row.ivMid}, ${row.ivBid}, ${row.ivAsk},
          ${row.midPrice}, ${row.oi}, ${row.volume}
        )
        RETURNING id
      `,
    ),
  );

  let inserted = 0;
  for (const r of results) {
    if (r.length > 0) inserted += 1;
  }
  return inserted;
}

// ── Per-ticker runner ────────────────────────────────────────

interface TickerResult {
  ticker: StrikeIVTicker;
  rowsInserted: number;
  skipped: boolean;
  reason?: string;
}

async function runTicker(
  ticker: StrikeIVTicker,
  sql: ReturnType<typeof getDb>,
  today: string,
  nowMs: number,
): Promise<TickerResult> {
  try {
    const expiries = buildExpirySet(today);
    const allowed = new Set(expiries);
    // Inclusive bounds for the Schwab call.
    const fromDate = expiries[0]!;
    const toDate = expiries[expiries.length - 1]!;

    const chain = await fetchChain(ticker, fromDate, toDate);
    if (chain == null) {
      return { ticker, rowsInserted: 0, skipped: true, reason: 'schwab_error' };
    }

    const rows = extractRows(chain, ticker, allowed, nowMs);
    if (rows.length === 0) {
      logger.info(
        { ticker, expiries, spot: chain.underlying?.last ?? null },
        'fetch-strike-iv: no rows after filter',
      );
      return { ticker, rowsInserted: 0, skipped: true, reason: 'empty_chain' };
    }

    const rowsInserted = await insertRows(sql, rows);

    logger.info(
      {
        ticker,
        spot: chain.underlying?.last ?? null,
        expiries,
        rowsInserted,
        candidateRows: rows.length,
      },
      'strike_iv_snapshots written',
    );

    return { ticker, rowsInserted, skipped: false };
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-strike-iv');
    Sentry.setTag('strike_iv.ticker', ticker);
    Sentry.captureException(err);
    logger.error({ err, ticker }, 'fetch-strike-iv: ticker failed');
    return {
      ticker,
      rowsInserted: 0,
      skipped: true,
      reason: 'exception',
    };
  }
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res, { requireApiKey: false });
  if (!guard) return;
  const { today } = guard;

  const startTime = Date.now();
  const sql = getDb();

  try {
    // Run tickers in parallel — they're independent and fault-isolated.
    const results = await Promise.all(
      STRIKE_IV_TICKERS.map((t) => runTicker(t, sql, today, startTime)),
    );

    const totalInserted = results.reduce((sum, r) => sum + r.rowsInserted, 0);
    const durationMs = Date.now() - startTime;

    return res.status(200).json({
      job: 'fetch-strike-iv',
      totalInserted,
      results,
      durationMs,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-strike-iv');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-strike-iv error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
