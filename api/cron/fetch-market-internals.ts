/**
 * GET /api/cron/fetch-market-internals
 *
 * Fetches 1-minute OHLC bars for the four NYSE market internals
 * ($TICK, $ADD, $VOLD, $TRIN) and stores them in the
 * `market_internals` table. Runs every minute during regular-session
 * hours.
 *
 * Data source split:
 *   - $TICK, $TRIN → /pricehistory (returns intraday 1-min bars)
 *   - $ADD, $VOLD  → /quotes (pricehistory only returns completed
 *     sessions for these symbols). We synthesize a flat bar
 *     (open=high=low=close=lastPrice) from the quote snapshot.
 *
 * SOURCE_UNAVAILABLE degrade (schwab-replacement-2026-08-16): the
 * schwabFetch facade has NO replacement source for NYSE breadth
 * internals — without Schwab configured every call returns 501
 * SOURCE_UNAVAILABLE. The cron treats that as a QUIET skip: no Sentry
 * event, at most one info log per run, feature columns stay NULL
 * downstream. Genuine errors (network, DB) still alert as before.
 *
 * Schwab passthrough (readiness-loose-ends-2026-08-18, phase G): when
 * SCHWAB_CLIENT_ID + SCHWAB_CLIENT_SECRET are set, the facade passes
 * these paths through to the real Schwab Market Data API, so the
 * breadth internals light back up once the owner completes OAuth. In
 * the window between "creds added" and "OAuth completed" the facade
 * returns the token envelope (401 SCHWAB_TOKEN_EXPIRED / 500
 * SCHWAB_TOKEN_ERROR) for every symbol every minute — that is treated
 * exactly like SOURCE_UNAVAILABLE for the skip decision (no Sentry, no
 * failure count) with ONE warn per run pointing at /api/auth/init.
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
 *   Each symbol is fetched independently via Promise.all with a per-symbol
 *   try/catch inside `processSymbol` (so the promise never rejects — it
 *   always resolves to a SymbolResult, with an `error` field on failure).
 *   If one symbol fails, the other three still commit. Per-symbol errors
 *   are logged and sent to Sentry but do not fail the whole run.
 *
 * Idempotence:
 *   INSERT ... ON CONFLICT (ts, symbol) DO NOTHING — safe to rerun.
 *   We fetch a 90-minute lookback to cover poll lag and short outages.
 *
 * Environment: CRON_SECRET (Schwab token managed internally)
 */

import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import {
  schwabFetch,
  checkDataQuality,
  withRetry,
  mapWithConcurrency,
} from '../_lib/api-helpers.js';
import { CRON_TICKER_DEFAULT_CONCURRENCY } from '../_lib/constants.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import { getETTotalMinutes } from '../../src/utils/timezone.js';
// INTERNAL_SYMBOLS is used by other modules; the cron now splits into
// PRICEHISTORY_SYMBOLS and QUOTES_ONLY_SYMBOLS defined below.
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
  /**
   * True when the symbol was skipped quietly: the facade reported 501
   * SOURCE_UNAVAILABLE (no breadth source exists) or Schwab is configured
   * but the OAuth flow hasn't been completed yet (see `notConnected`).
   * Not an error — the handler logs once per run per reason and neither
   * Sentry nor the failure count sees these.
   */
  unavailable?: boolean;
  /**
   * Sub-reason for `unavailable`: the Schwab passthrough returned the
   * token envelope (SCHWAB_TOKEN_EXPIRED / SCHWAB_TOKEN_ERROR) — creds are
   * set but the owner hasn't visited /api/auth/init (or the refresh token
   * lapsed). Surfaces as ONE warn per run instead of one error per symbol.
   */
  notConnected?: boolean;
}

/** Facade "no source for this path" marker — expected, not an error. */
class SourceUnavailableError extends Error {}

/**
 * Facade passthrough "Schwab configured but not connected" marker — the
 * token machinery answered instead of Schwab. Expected during the OAuth
 * window; not an error.
 */
class SchwabNotConnectedError extends Error {}

/** Facade result codes emitted by the OAuth token machinery. */
const SCHWAB_NOT_CONNECTED_CODES = new Set([
  'SCHWAB_TOKEN_EXPIRED',
  'SCHWAB_TOKEN_ERROR',
]);

function isSourceUnavailable(result: {
  status: number;
  code?: string;
}): boolean {
  return result.status === 501 || result.code === 'SOURCE_UNAVAILABLE';
}

function isSchwabNotConnected(result: { code?: string }): boolean {
  return result.code != null && SCHWAB_NOT_CONNECTED_CODES.has(result.code);
}

function unavailableResult(
  symbol: InternalSymbol,
  opts: { notConnected?: boolean } = {},
): SymbolResult {
  return {
    symbol,
    fetched: 0,
    filtered: 0,
    stored: 0,
    skipped: 0,
    unavailable: true,
    ...(opts.notConnected ? { notConnected: true } : {}),
  };
}

// Regular-session bounds in ET minutes-of-day.
// 9:30 AM = 9*60+30 = 570, 4:00 PM = 16*60 = 960.
const SESSION_OPEN_MIN = 570;
const SESSION_CLOSE_MIN = 960;

// Schwab pricehistory returns intraday bars for TICK/TRIN but only
// completed sessions for ADD/VOLD. The latter use /quotes instead.
const PRICEHISTORY_SYMBOLS: InternalSymbol[] = ['$TICK', '$TRIN'];
const QUOTES_ONLY_SYMBOLS: InternalSymbol[] = ['$ADD', '$VOLD'];

/** Schwab quote response shape (subset of fields we need). */
interface SchwabQuoteEntry {
  quote?: { lastPrice?: number };
}

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
    if (isSourceUnavailable(result)) {
      throw new SourceUnavailableError(result.error);
    }
    if (isSchwabNotConnected(result)) {
      throw new SchwabNotConnectedError(result.error);
    }
    throw new Error(`pricehistory ${result.status}: ${result.error}`);
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
    if (err instanceof SourceUnavailableError) {
      // Expected degrade — no breadth source behind the facade. The
      // handler logs this once per run; no Sentry noise.
      return unavailableResult(symbol);
    }
    if (err instanceof SchwabNotConnectedError) {
      // Expected during the OAuth window — creds set, no tokens yet.
      // The handler warns once per run; no Sentry noise.
      return unavailableResult(symbol, { notConnected: true });
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, symbol }, 'fetch-market-internals: per-symbol failure');
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

// ── Quote-based pipeline for $ADD/$VOLD ────────────────────

/**
 * Fetch current values for symbols that Schwab pricehistory doesn't
 * serve intraday, and synthesize flat bars (open=high=low=close).
 */
async function processQuoteSymbols(
  symbols: InternalSymbol[],
): Promise<SymbolResult[]> {
  if (symbols.length === 0) return [];

  const symbolList = symbols.map((s) => encodeURIComponent(s)).join(',');
  try {
    const result = await withRetry(() =>
      schwabFetch<Record<string, SchwabQuoteEntry>>(
        `/quotes?symbols=${symbolList}&fields=quote`,
      ),
    );

    if (!result.ok) {
      if (isSourceUnavailable(result)) {
        // Expected degrade — quiet skip, handler logs once per run.
        return symbols.map((symbol) => unavailableResult(symbol));
      }
      if (isSchwabNotConnected(result)) {
        // Expected during the OAuth window — quiet skip, handler warns
        // once per run.
        return symbols.map((symbol) =>
          unavailableResult(symbol, { notConnected: true }),
        );
      }
      return symbols.map((symbol) => ({
        symbol,
        fetched: 0,
        filtered: 0,
        stored: 0,
        skipped: 0,
        error: `quotes ${result.status}: ${result.error}`,
      }));
    }

    const now = new Date();
    now.setSeconds(0, 0); // Truncate to minute boundary
    const ts = now.toISOString();

    const results: SymbolResult[] = [];
    for (const symbol of symbols) {
      const price = result.data[symbol]?.quote?.lastPrice;
      if (price == null || !Number.isFinite(price)) {
        results.push({
          symbol,
          fetched: 1,
          filtered: 0,
          stored: 0,
          skipped: 0,
          error: `No valid lastPrice for ${symbol}`,
        });
        continue;
      }

      try {
        const row: InternalBarRow = {
          ts,
          symbol,
          open: price,
          high: price,
          low: price,
          close: price,
        };
        const { stored, skipped } = await withRetry(() => storeBars([row]));
        results.push({
          symbol,
          fetched: 1,
          filtered: 0,
          stored,
          skipped,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          { err, symbol },
          'fetch-market-internals: quote store failure',
        );
        Sentry.captureException(err);
        results.push({
          symbol,
          fetched: 1,
          filtered: 0,
          stored: 0,
          skipped: 0,
          error: msg,
        });
      }
    }
    return results;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err, symbols },
      'fetch-market-internals: quotes fetch failure',
    );
    Sentry.captureException(err);
    return symbols.map((symbol) => ({
      symbol,
      fetched: 0,
      filtered: 0,
      stored: 0,
      skipped: 0,
      error: msg,
    }));
  }
}

// ── Handler ─────────────────────────────────────────────────

export default withCronInstrumentation(
  'fetch-market-internals',
  async (ctx): Promise<CronResult> => {
    const { today } = ctx;

    const endMs = Date.now();
    const startMs = endMs - 90 * 60 * 1000; // last 90 minutes

    // Fetch both groups in parallel:
    // - pricehistory symbols ($TICK, $TRIN) get full OHLC bars
    // - quotes-only symbols ($ADD, $VOLD) get current-value snapshots
    // mapWithConcurrency caps the per-symbol fan-out so a future symbol
    // expansion doesn't 429 against Schwab's per-app concurrency budget.
    const [priceHistoryResults, quoteResults] = await Promise.all([
      mapWithConcurrency(
        PRICEHISTORY_SYMBOLS,
        CRON_TICKER_DEFAULT_CONCURRENCY,
        (s) => processSymbol(s, startMs, endMs),
      ),
      processQuoteSymbols(QUOTES_ONLY_SYMBOLS),
    ]);

    const results = [...priceHistoryResults, ...quoteResults];

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
    const unavailable = results.filter((r) => r.unavailable);
    const notConnected = unavailable.filter((r) => r.notConnected);
    const noSource = unavailable.filter((r) => !r.notConnected);
    const successes = results.filter((r) => !r.error && !r.unavailable);

    if (noSource.length > 0) {
      // Single per-run note (NOT Sentry): the facade has no breadth
      // source, so these symbols are expected to skip every run until
      // one is added — see schwab-replacement-2026-08-16.
      ctx.logger.info(
        { symbols: noSource.map((u) => u.symbol) },
        'fetch-market-internals: no market-data source (SOURCE_UNAVAILABLE) — skipping',
      );
    }

    if (notConnected.length > 0) {
      // Single per-run warn (NOT Sentry): Schwab creds are set so the
      // passthrough is live, but there are no OAuth tokens yet. The
      // owner has to complete the browser flow once; until then every
      // run lands here — one line, not one error per symbol per minute.
      ctx.logger.warn(
        { symbols: notConnected.map((u) => u.symbol) },
        'fetch-market-internals: schwab configured but not connected — visit /api/auth/init',
      );
    }

    ctx.logger.info(
      {
        date: today,
        ...totals,
        successCount: successes.length,
        failureCount: failures.length,
        unavailableCount: unavailable.length,
        notConnectedCount: notConnected.length,
        failures: failures.map((f) => ({ symbol: f.symbol, error: f.error })),
      },
      'fetch-market-internals completed',
    );

    // Data quality check: only fire when we stored enough rows for the
    // day. Uses a nonzero "close" value as the liveness signal.
    if (totals.stored > 10) {
      // Liveness check: $ADD, $VOLD, $TRIN are effectively never 0 intraday,
      // and a $TICK reading of exactly 0 is rare. If the aggregate nonzero
      // count across all 4 symbols drops to 0 while `total` is large, Schwab
      // is returning synthetic/empty bars — surface it via checkDataQuality.
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

    return {
      status: failures.length === 0 ? 'success' : 'partial',
      metadata: {
        success: true,
        ...totals,
        successCount: successes.length,
        failureCount: failures.length,
        unavailableCount: unavailable.length,
        notConnectedCount: notConnected.length,
        results,
      },
    };
  },
  { requireApiKey: false },
);
