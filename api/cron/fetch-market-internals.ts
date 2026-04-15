/**
 * GET /api/cron/fetch-market-internals
 *
 * Fetches 1-minute OHLC bars for the four NYSE market internals
 * ($TICK, $ADD, $VOLD, $TRIN) from Schwab /pricehistory and stores
 * them in the `market_internals` table. Runs every minute during
 * regular-session hours.
 *
 * Why per-minute polling:
 *   - $TICK/$ADD/$VOLD/$TRIN change second-by-second during the session.
 *     1-min bars are the standard granularity for the breadth panel.
 *
 * Extended-hours filter:
 *   Verification showed Schwab returns extended-hours bars for $TICK
 *   and $TRIN even with `needExtendedHoursData=false`. We filter in
 *   code to ET minutes-of-day [570, 960] (9:30 AM - 4:00 PM inclusive)
 *   before insert to keep the table clean.
 *
 * Error handling:
 *   Each symbol is fetched independently via Promise.allSettled. If one
 *   symbol fails, the other three still commit. Per-symbol errors are
 *   logged and sent to Sentry but do not fail the whole run.
 *
 * Idempotence:
 *   INSERT ... ON CONFLICT (ts, symbol) DO NOTHING — safe to rerun.
 *   We fetch a 90-minute lookback to cover poll lag and short outages.
 *
 * Environment: CRON_SECRET (Schwab token managed internally)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import {
  schwabFetch,
  cronGuard,
  checkDataQuality,
  withRetry,
} from '../_lib/api-helpers.js';
import { reportCronRun } from '../_lib/axiom.js';
import { getETTotalMinutes } from '../../src/utils/timezone.js';
import { INTERNAL_SYMBOLS } from '../../src/constants/market-internals.js';
import type { InternalSymbol } from '../../src/types/market-internals.js';

// ── Types ───────────────────────────────────────────────────

interface SchwabCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  datetime: number;
}

interface SchwabPriceHistory {
  symbol: string;
  empty: boolean;
  candles: SchwabCandle[];
}

interface InternalBarRow {
  ts: string; // ISO timestamp
  symbol: InternalSymbol;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface SymbolResult {
  symbol: InternalSymbol;
  fetched: number;
  filtered: number;
  stored: number;
  skipped: number;
  error?: string;
}

// Regular-session bounds in ET minutes-of-day.
// 9:30 AM = 9*60+30 = 570, 4:00 PM = 16*60 = 960.
const SESSION_OPEN_MIN = 570;
const SESSION_CLOSE_MIN = 960;

// ── Fetch helper ────────────────────────────────────────────

async function fetchInternalCandles(
  symbol: InternalSymbol,
  startMs: number,
  endMs: number,
): Promise<SchwabCandle[]> {
  const params = new URLSearchParams({
    symbol,
    periodType: 'day',
    frequencyType: 'minute',
    frequency: '1',
    startDate: String(startMs),
    endDate: String(endMs),
    needExtendedHoursData: 'false',
    needPreviousClose: 'false',
  });

  const result = await schwabFetch<SchwabPriceHistory>(
    `/pricehistory?${params.toString()}`,
  );

  if (!result.ok) {
    throw new Error(`Schwab pricehistory ${result.status}: ${result.error}`);
  }
  return result.data.candles ?? [];
}

// ── Filter helper ───────────────────────────────────────────

/**
 * Keep only bars whose timestamp falls within the regular NYSE session
 * in America/New_York. Drops any extended-hours bars Schwab returns
 * despite `needExtendedHoursData=false`.
 */
function filterToRegularSession(candles: SchwabCandle[]): SchwabCandle[] {
  const kept: SchwabCandle[] = [];
  for (const c of candles) {
    const d = new Date(c.datetime);
    const etMin = getETTotalMinutes(d);
    if (etMin >= SESSION_OPEN_MIN && etMin <= SESSION_CLOSE_MIN) {
      kept.push(c);
    }
  }
  return kept;
}

// ── Normalize helper ────────────────────────────────────────

function toRows(
  candles: SchwabCandle[],
  symbol: InternalSymbol,
): InternalBarRow[] {
  const rows: InternalBarRow[] = [];
  for (const c of candles) {
    if (
      !Number.isFinite(c.open) ||
      !Number.isFinite(c.high) ||
      !Number.isFinite(c.low) ||
      !Number.isFinite(c.close)
    ) {
      continue;
    }
    rows.push({
      ts: new Date(c.datetime).toISOString(),
      symbol,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    });
  }
  return rows;
}

// ── Store helper ────────────────────────────────────────────

async function storeBars(
  rows: InternalBarRow[],
): Promise<{ stored: number; skipped: number }> {
  if (rows.length === 0) return { stored: 0, skipped: 0 };

  const sql = getDb();

  const results = await sql.transaction((txn) =>
    rows.map(
      (row) => txn`
        INSERT INTO market_internals (ts, symbol, open, high, low, close)
        VALUES (
          ${row.ts}, ${row.symbol},
          ${row.open}, ${row.high}, ${row.low}, ${row.close}
        )
        ON CONFLICT (ts, symbol) DO NOTHING
        RETURNING ts
      `,
    ),
  );

  let stored = 0;
  for (const result of results) {
    if (result.length > 0) stored++;
  }
  return { stored, skipped: rows.length - stored };
}

// ── Per-symbol pipeline ─────────────────────────────────────

async function processSymbol(
  symbol: InternalSymbol,
  startMs: number,
  endMs: number,
): Promise<SymbolResult> {
  try {
    const raw = await withRetry(() =>
      fetchInternalCandles(symbol, startMs, endMs),
    );
    const filteredCandles = filterToRegularSession(raw);
    const filteredOut = raw.length - filteredCandles.length;
    const rows = toRows(filteredCandles, symbol);

    const { stored, skipped } = await withRetry(() => storeBars(rows));

    return {
      symbol,
      fetched: raw.length,
      filtered: filteredOut,
      stored,
      skipped,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, symbol }, 'fetch-market-internals: per-symbol failure');
    Sentry.setTag('cron.job', 'fetch-market-internals');
    Sentry.setTag('cron.symbol', symbol);
    Sentry.captureException(err);
    return {
      symbol,
      fetched: 0,
      filtered: 0,
      stored: 0,
      skipped: 0,
      error: msg,
    };
  }
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res, { requireApiKey: false });
  if (!guard) return;
  const { today } = guard;

  const startTime = Date.now();

  try {
    const endMs = Date.now();
    const startMs = endMs - 90 * 60 * 1000; // last 90 minutes

    const results = await Promise.all(
      INTERNAL_SYMBOLS.map((symbol) => processSymbol(symbol, startMs, endMs)),
    );

    const totals = results.reduce(
      (acc, r) => ({
        fetched: acc.fetched + r.fetched,
        filtered: acc.filtered + r.filtered,
        stored: acc.stored + r.stored,
        skipped: acc.skipped + r.skipped,
      }),
      { fetched: 0, filtered: 0, stored: 0, skipped: 0 },
    );

    const failures = results.filter((r) => r.error);
    const successes = results.filter((r) => !r.error);

    logger.info(
      {
        date: today,
        ...totals,
        successCount: successes.length,
        failureCount: failures.length,
        failures: failures.map((f) => ({ symbol: f.symbol, error: f.error })),
      },
      'fetch-market-internals completed',
    );

    // Data quality check: only fire when we stored enough rows for the
    // day. Uses a nonzero "close" value as the liveness signal.
    if (totals.stored > 10) {
      const qcRows = await getDb()`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE close <> 0) AS nonzero
        FROM market_internals
        WHERE ts::date = ${today}::date
      `;
      const { total, nonzero } = qcRows[0]!;
      await checkDataQuality({
        job: 'fetch-market-internals',
        table: 'market_internals',
        date: today,
        sourceFilter: '1-minute $TICK/$ADD/$VOLD/$TRIN bars',
        total: Number(total),
        nonzero: Number(nonzero),
      });
    }

    await reportCronRun('fetch-market-internals', {
      status: failures.length === 0 ? 'ok' : 'partial',
      ...totals,
      successCount: successes.length,
      failureCount: failures.length,
      durationMs: Date.now() - startTime,
    });

    return res.status(200).json({
      job: 'fetch-market-internals',
      success: true,
      ...totals,
      successCount: successes.length,
      failureCount: failures.length,
      results,
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-market-internals');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-market-internals error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
