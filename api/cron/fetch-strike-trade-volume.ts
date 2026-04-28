/**
 * GET /api/cron/fetch-strike-trade-volume
 *
 * 1-minute cron that snapshots per-strike per-minute tape-side volume
 * for the watchlist tickers from UW
 * `/api/stock/{ticker}/flow-per-strike-intraday`. Feeds the bid-side-
 * surge exit signal in `useIVAnomalies` (Phase 3) — replaces the
 * prior firing-rate-surge proxy with real tape data.
 *
 * Per ticker, per run:
 *   1. Fetch flow-per-strike-intraday for today
 *   2. Pick the most recent minute bucket per strike
 *   3. Split each row into call + put rows (UW returns them combined
 *      in a single record with separate `call_volume_*` and
 *      `put_volume_*` fields)
 *   4. Insert into strike_trade_volume keyed on (ticker, strike, side, ts)
 *
 * Note: UW's flow-per-strike-intraday aggregates ACROSS expiries — the
 * table doesn't have an expiry column. This is intentional: tape-side
 * surge detection on (ticker, strike, side) is sufficient for the exit
 * signal even when the original anomaly fired at a specific expiry.
 *
 * Cron cadence: `* 13-21 * * 1-5` — every minute during market hours.
 * Volume budget: 13 tickers × 1 request/min = 780 UW requests/hour.
 *
 * Environment: CRON_SECRET, UW_API_KEY.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import {
  cronGuard,
  mapWithConcurrency,
  uwFetch,
  withRetry,
} from '../_lib/api-helpers.js';
import { STRIKE_IV_TICKERS, type StrikeIVTicker } from '../_lib/constants.js';

// ── UW response types ────────────────────────────────────────

interface FlowPerStrikeRow {
  ticker: string;
  strike: string;
  timestamp: string;
  call_volume: string;
  call_volume_ask_side: string;
  call_volume_bid_side: string;
  put_volume: string;
  put_volume_ask_side: string;
  put_volume_bid_side: string;
}

// ── Row payload for insert ───────────────────────────────────

interface VolumeRow {
  ticker: StrikeIVTicker;
  strike: number;
  side: 'call' | 'put';
  ts: string;
  bidSideVol: number;
  askSideVol: number;
  midVol: number;
  totalVol: number;
}

// ── UW symbol mapping ────────────────────────────────────────

/**
 * UW's flow-per-strike-intraday is a per-stock endpoint. Cash indices
 * trade under the cash-symbol path (SPX/NDX), not the weekly root
 * (SPXW/NDXP). Map the watchlist ticker to its UW path symbol.
 */
function uwSymbol(ticker: StrikeIVTicker): string {
  switch (ticker) {
    case 'SPXW':
      return 'SPX';
    case 'NDXP':
      return 'NDX';
    case 'SPY':
    case 'QQQ':
    case 'IWM':
    case 'SMH':
    case 'NVDA':
    case 'TSLA':
    case 'META':
    case 'MSFT':
    case 'GOOGL':
    case 'SNDK':
    case 'MSTR':
    case 'MU':
      return ticker;
    default: {
      const _exhaustive: never = ticker;
      throw new Error(`No UW symbol for ticker: ${String(_exhaustive)}`);
    }
  }
}

// ── Row extraction ───────────────────────────────────────────

/**
 * Take the raw UW rows for a ticker and reduce to the LATEST minute
 * bucket per (strike). UW returns multiple rows per strike (one per
 * minute since open) — the cron stores only the most recent minute
 * per run, building the time series incrementally across runs.
 *
 * Splits each row into separate call + put inserts (`side` column).
 */
function extractRows(
  ticker: StrikeIVTicker,
  rows: FlowPerStrikeRow[],
): VolumeRow[] {
  // Group by strike, keep latest ts per strike
  const byStrike = new Map<string, FlowPerStrikeRow>();
  for (const r of rows) {
    const existing = byStrike.get(r.strike);
    if (!existing || Date.parse(r.timestamp) > Date.parse(existing.timestamp)) {
      byStrike.set(r.strike, r);
    }
  }

  const out: VolumeRow[] = [];
  for (const r of byStrike.values()) {
    const strike = Number(r.strike);
    if (!Number.isFinite(strike)) continue;
    const ts = r.timestamp;
    // Skip empty strikes — both call and put volumes are 0
    const callTotal = Number(r.call_volume) || 0;
    const putTotal = Number(r.put_volume) || 0;
    if (callTotal > 0) {
      const callAsk = Number(r.call_volume_ask_side) || 0;
      const callBid = Number(r.call_volume_bid_side) || 0;
      out.push({
        ticker,
        strike,
        side: 'call',
        ts,
        bidSideVol: callBid,
        askSideVol: callAsk,
        midVol: Math.max(0, callTotal - callAsk - callBid),
        totalVol: callTotal,
      });
    }
    if (putTotal > 0) {
      const putAsk = Number(r.put_volume_ask_side) || 0;
      const putBid = Number(r.put_volume_bid_side) || 0;
      out.push({
        ticker,
        strike,
        side: 'put',
        ts,
        bidSideVol: putBid,
        askSideVol: putAsk,
        midVol: Math.max(0, putTotal - putAsk - putBid),
        totalVol: putTotal,
      });
    }
  }
  return out;
}

// ── DB insert ────────────────────────────────────────────────

async function insertRows(
  sql: ReturnType<typeof getDb>,
  rows: VolumeRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const results = await sql.transaction((txn) =>
    rows.map(
      (row) => txn`
        INSERT INTO strike_trade_volume (
          ticker, strike, side, ts,
          bid_side_vol, ask_side_vol, mid_vol, total_vol
        )
        VALUES (
          ${row.ticker}, ${row.strike}, ${row.side}, ${row.ts},
          ${row.bidSideVol}, ${row.askSideVol}, ${row.midVol}, ${row.totalVol}
        )
        RETURNING id
      `,
    ),
  );
  let inserted = 0;
  for (const r of results) if (r.length > 0) inserted += 1;
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
  apiKey: string,
  sql: ReturnType<typeof getDb>,
  today: string,
): Promise<TickerResult> {
  try {
    const path = `/stock/${uwSymbol(ticker)}/flow-per-strike-intraday?date=${today}`;
    const rows = await withRetry(() => uwFetch<FlowPerStrikeRow>(apiKey, path));
    if (rows.length === 0) {
      return {
        ticker,
        rowsInserted: 0,
        skipped: true,
        reason: 'empty_flow',
      };
    }
    const extracted = extractRows(ticker, rows);
    const rowsInserted = await insertRows(sql, extracted);
    logger.info(
      {
        ticker,
        totalRows: rows.length,
        candidateRows: extracted.length,
        rowsInserted,
      },
      'strike_trade_volume written',
    );
    return { ticker, rowsInserted, skipped: false };
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-strike-trade-volume');
    Sentry.setTag('strike_trade_volume.ticker', ticker);
    Sentry.captureException(err);
    logger.error({ err, ticker }, 'fetch-strike-trade-volume: ticker failed');
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
  const guard = cronGuard(req, res);
  if (!guard) return;
  const { apiKey, today } = guard;

  const startTime = Date.now();
  const sql = getDb();

  try {
    // UW plan caps concurrent in-flight requests at 3. Firing all 14 tickers
    // via `Promise.all` reliably 429s the last 11. A 3-wide worker pool keeps
    // the cron under that ceiling; total wall-clock is ~5 sequential rounds
    // (≈ 1.5–2 s at typical UW latency), well under function timeout.
    const results = await mapWithConcurrency(STRIKE_IV_TICKERS, 3, (t) =>
      runTicker(t, apiKey, sql, today),
    );
    const totalInserted = results.reduce((sum, r) => sum + r.rowsInserted, 0);
    const durationMs = Date.now() - startTime;
    return res.status(200).json({
      job: 'fetch-strike-trade-volume',
      totalInserted,
      results,
      durationMs,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-strike-trade-volume');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-strike-trade-volume error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
