/**
 * GET /api/cron/fetch-gex-strike-expiry-etfs
 *
 * Fetches per-strike GEX (gamma / charm / vanna by OI, vol, ask-vol,
 * bid-vol) for SPY, QQQ, and NDX from UW's REST endpoint every minute
 * during market hours, then UPSERTs rows into `ws_gex_strike_expiry`.
 *
 * This gives the GEX Landscape panel the same intraday per-minute
 * density for ETF/index tickers that `fetch-gex-0dte` gives SPX. The
 * UW WebSocket channel `gex_strike_expiry:<TICKER>` only fires once per
 * day (EOD, ~20:14 UTC), so REST polling is the only way to accumulate
 * intraday snapshots for SPY/QQQ/NDX.
 *
 * Per-ticker config:
 *   - SPY: ±20 pts ATM window, 0DTE expiry (today)
 *   - QQQ: ±20 pts ATM window, 0DTE expiry (today)
 *   - NDX: ±500 pts ATM window, front monthly expiry (3rd Friday)
 *
 * Each ticker runs independently via Promise.allSettled so one UW
 * failure does not block the other two. Total UW calls per invocation:
 * 6 (2 preflight + 1 main call per ticker).
 *
 * UW workaround (same as fetch-gex-0dte): the main
 * /spot-exposures/expiry-strike endpoint serves stale cached data unless
 * the request carries a narrow min_strike/max_strike window. We prefetch
 * spot from /spot-exposures/strike (always-live) per ticker first.
 *
 * UPSERT key: (ticker, expiry, strike, ts_minute)
 * Timestamps are truncated to whole minutes via DATE_TRUNC in SQL so
 * repeated calls within the same minute collapse to a single row
 * (last-write-wins, matching the WS daemon's UPSERT pattern).
 *
 * Field name mapping (REST → DB):
 *   call_gamma_ask  → call_gamma_ask_vol
 *   call_gamma_bid  → call_gamma_bid_vol
 *   put_gamma_ask   → put_gamma_ask_vol
 *   put_gamma_bid   → put_gamma_bid_vol
 *   (same pattern for charm/vanna ask/bid)
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { uwFetch, cronJitter, withRetry } from '../_lib/api-helpers.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import {
  getPrimaryExpiry,
  type ZeroGammaTicker,
} from '../_lib/zero-gamma-tickers.js';

// ── Ticker config ─────────────────────────────────────────────

type EtfTicker = Extract<ZeroGammaTicker, 'SPY' | 'QQQ' | 'NDX'>;

const TICKERS: EtfTicker[] = ['SPY', 'QQQ', 'NDX'];

const ATM_RANGE_BY_TICKER: Record<EtfTicker, number> = {
  SPY: 20,
  QQQ: 20,
  NDX: 500,
};

// ── Types ─────────────────────────────────────────────────────

interface StrikeRow {
  strike: string;
  price: string;
  time: string;
  call_gamma_oi: string;
  put_gamma_oi: string;
  call_gamma_vol: string;
  put_gamma_vol: string;
  call_gamma_ask: string;
  call_gamma_bid: string;
  put_gamma_ask: string;
  put_gamma_bid: string;
  call_charm_oi: string;
  put_charm_oi: string;
  call_charm_vol: string;
  put_charm_vol: string;
  call_charm_ask: string;
  call_charm_bid: string;
  put_charm_ask: string;
  put_charm_bid: string;
  call_vanna_oi: string;
  put_vanna_oi: string;
  call_vanna_vol: string;
  put_vanna_vol: string;
  call_vanna_ask: string;
  call_vanna_bid: string;
  put_vanna_ask: string;
  put_vanna_bid: string;
}

interface TickerResult {
  ticker: EtfTicker;
  stored: number;
  skipped: number;
  total: number;
  error?: string;
}

// ── Fetch helpers ─────────────────────────────────────────────

/**
 * Preflight: fetch the current spot price for a ticker from UW's
 * always-live /spot-exposures/strike endpoint. Returns null on any
 * failure; the main call falls back to an unbounded request.
 */
async function fetchSpotPrice(
  apiKey: string,
  ticker: EtfTicker,
): Promise<number | null> {
  try {
    const rows = await uwFetch<{ price: string }>(
      apiKey,
      `/stock/${ticker}/spot-exposures/strike?limit=1`,
    );
    const raw = rows[0]?.price;
    if (raw === undefined) return null;
    const price = Number.parseFloat(raw);
    return Number.isFinite(price) ? price : null;
  } catch (err) {
    logger.warn(
      { err, ticker },
      'fetch-gex-strike-expiry-etfs: spot preflight failed',
    );
    return null;
  }
}

async function fetchExpiryStrike(
  apiKey: string,
  ticker: EtfTicker,
  expiry: string,
  spotPrice: number | null,
): Promise<StrikeRow[]> {
  const atmRange = ATM_RANGE_BY_TICKER[ticker];
  const params = new URLSearchParams({
    date: expiry,
    'expirations[]': expiry,
    limit: '500',
  });

  if (spotPrice !== null) {
    params.set('min_strike', String(Math.floor(spotPrice - atmRange)));
    params.set('max_strike', String(Math.ceil(spotPrice + atmRange)));
  }

  return uwFetch<StrikeRow>(
    apiKey,
    `/stock/${ticker}/spot-exposures/expiry-strike?${params}`,
  );
}

// ── Store helper ──────────────────────────────────────────────

/**
 * Batch-UPSERT strike rows for a single ticker into ws_gex_strike_expiry.
 *
 * Timestamps are truncated to the whole minute via DATE_TRUNC in the
 * INSERT expression so repeated calls within the same minute collapse to
 * a single row per (ticker, expiry, strike, ts_minute). This matches the
 * WS daemon's UPSERT pattern and ensures the unique constraint is used
 * for deduplication rather than for insertion failure.
 *
 * Field rename: REST emits `call_gamma_ask` (no _vol suffix); the table
 * column is `call_gamma_ask_vol`. Same for all charm/vanna ask/bid pairs.
 *
 * The raw UW row is stored as raw_payload JSONB for forward-compat.
 */
async function storeStrikes(
  rows: StrikeRow[],
  ticker: EtfTicker,
  expiry: string,
  spotPrice: number | null,
): Promise<{ stored: number; skipped: number }> {
  if (rows.length === 0) return { stored: 0, skipped: 0 };

  // Filter to ATM window when spot is available (same workaround as
  // fetch-gex-0dte — UW may return extra strikes if the cache is stale)
  const atmRange = ATM_RANGE_BY_TICKER[ticker];
  const filtered =
    spotPrice !== null
      ? rows.filter((r) => {
          const s = Number.parseFloat(r.strike);
          return s >= spotPrice - atmRange && s <= spotPrice + atmRange;
        })
      : [...rows];

  if (filtered.length === 0) return { stored: 0, skipped: 0 };

  // Sort by numeric strike before building VALUES clauses so this cron
  // and the uw-stream Python daemon both acquire row locks on
  // ws_gex_strike_expiry in the same order. Without this, UW REST and
  // WS payloads can arrive in different strike orders for the same
  // (ticker, expiry, ts_minute) batch and trigger AB-BA deadlocks
  // (SQLSTATE 40P01) on overlapping UPSERTs.
  filtered.sort(
    (a, b) => Number.parseFloat(a.strike) - Number.parseFloat(b.strike),
  );

  const sql = getDb();

  // Single multi-row INSERT — one HTTP round-trip to Neon regardless of
  // how many strikes are in the ATM window.
  // 30 columns per row: 5 key fields + 12 OI/vol greeks + 12 ask/bid-vol
  // greeks + 1 raw_payload. Must match the sqlParams.push count below.
  const COLUMNS_PER_ROW = 30;
  const sqlParams: unknown[] = [];
  const valuesClauses: string[] = [];

  for (const row of filtered) {
    const base = sqlParams.length;
    const placeholders: string[] = [];
    for (let i = 1; i <= COLUMNS_PER_ROW; i++) {
      placeholders.push(`$${base + i}`);
    }
    // ts_minute is pre-truncated to the whole minute in JS (floor to
    // nearest 60s) so the unique constraint (ticker, expiry, strike,
    // ts_minute) fires correctly. Slot layout:
    //  1=ticker, 2=expiry, 3=strike, 4=ts_minute, 5=price,
    //  6–17=OI+vol greeks, 18–29=ask/bid-vol greeks, 30=raw_payload
    valuesClauses.push(`(${placeholders.join(',')})`);

    // Truncate timestamp to nearest minute (floor) in JS, same as the
    // backfill script:  t - (t % 60_000)
    const rawTime = row.time;
    const tMs = new Date(rawTime).getTime();
    const tsMinute = Number.isFinite(tMs)
      ? new Date(tMs - (tMs % 60_000)).toISOString()
      : new Date(`${expiry}T21:00:00Z`).toISOString();

    sqlParams.push(
      ticker,
      expiry,
      row.strike,
      tsMinute,
      row.price,
      row.call_gamma_oi,
      row.put_gamma_oi,
      row.call_charm_oi,
      row.put_charm_oi,
      row.call_vanna_oi,
      row.put_vanna_oi,
      row.call_gamma_vol,
      row.put_gamma_vol,
      row.call_charm_vol,
      row.put_charm_vol,
      row.call_vanna_vol,
      row.put_vanna_vol,
      row.call_gamma_ask, // → call_gamma_ask_vol
      row.call_gamma_bid, // → call_gamma_bid_vol
      row.put_gamma_ask, // → put_gamma_ask_vol
      row.put_gamma_bid, // → put_gamma_bid_vol
      row.call_charm_ask, // → call_charm_ask_vol
      row.call_charm_bid, // → call_charm_bid_vol
      row.put_charm_ask, // → put_charm_ask_vol
      row.put_charm_bid, // → put_charm_bid_vol
      row.call_vanna_ask, // → call_vanna_ask_vol
      row.call_vanna_bid, // → call_vanna_bid_vol
      row.put_vanna_ask, // → put_vanna_ask_vol
      row.put_vanna_bid, // → put_vanna_bid_vol
      JSON.stringify(row),
    );
  }

  const insertSql = `
    INSERT INTO ws_gex_strike_expiry (
      ticker, expiry, strike, ts_minute, price,
      call_gamma_oi, put_gamma_oi,
      call_charm_oi, put_charm_oi,
      call_vanna_oi, put_vanna_oi,
      call_gamma_vol, put_gamma_vol,
      call_charm_vol, put_charm_vol,
      call_vanna_vol, put_vanna_vol,
      call_gamma_ask_vol, call_gamma_bid_vol,
      put_gamma_ask_vol, put_gamma_bid_vol,
      call_charm_ask_vol, call_charm_bid_vol,
      put_charm_ask_vol, put_charm_bid_vol,
      call_vanna_ask_vol, call_vanna_bid_vol,
      put_vanna_ask_vol, put_vanna_bid_vol,
      raw_payload
    )
    VALUES ${valuesClauses.join(',')}
    ON CONFLICT (ticker, expiry, strike, ts_minute) DO UPDATE SET
      price              = EXCLUDED.price,
      call_gamma_oi      = EXCLUDED.call_gamma_oi,
      put_gamma_oi       = EXCLUDED.put_gamma_oi,
      call_charm_oi      = EXCLUDED.call_charm_oi,
      put_charm_oi       = EXCLUDED.put_charm_oi,
      call_vanna_oi      = EXCLUDED.call_vanna_oi,
      put_vanna_oi       = EXCLUDED.put_vanna_oi,
      call_gamma_vol     = EXCLUDED.call_gamma_vol,
      put_gamma_vol      = EXCLUDED.put_gamma_vol,
      call_charm_vol     = EXCLUDED.call_charm_vol,
      put_charm_vol      = EXCLUDED.put_charm_vol,
      call_vanna_vol     = EXCLUDED.call_vanna_vol,
      put_vanna_vol      = EXCLUDED.put_vanna_vol,
      call_gamma_ask_vol = EXCLUDED.call_gamma_ask_vol,
      call_gamma_bid_vol = EXCLUDED.call_gamma_bid_vol,
      put_gamma_ask_vol  = EXCLUDED.put_gamma_ask_vol,
      put_gamma_bid_vol  = EXCLUDED.put_gamma_bid_vol,
      call_charm_ask_vol = EXCLUDED.call_charm_ask_vol,
      call_charm_bid_vol = EXCLUDED.call_charm_bid_vol,
      put_charm_ask_vol  = EXCLUDED.put_charm_ask_vol,
      put_charm_bid_vol  = EXCLUDED.put_charm_bid_vol,
      call_vanna_ask_vol = EXCLUDED.call_vanna_ask_vol,
      call_vanna_bid_vol = EXCLUDED.call_vanna_bid_vol,
      put_vanna_ask_vol  = EXCLUDED.put_vanna_ask_vol,
      put_vanna_bid_vol  = EXCLUDED.put_vanna_bid_vol,
      raw_payload        = EXCLUDED.raw_payload
    RETURNING (xmax = 0) AS was_insert
  `;

  // Retry once on transient lock conflicts with the uw-stream daemon.
  // 40P01 = deadlock_detected, 40001 = serialization_failure. Postgres
  // aborts the losing transaction; a fresh attempt typically wins
  // because the deterministic sort above means both writers now queue
  // for the same row in the same order.
  const MAX_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = (await sql.query(insertSql, sqlParams)) as Array<{
        was_insert: boolean;
      }>;
      const stored = result.filter((r) => r.was_insert).length;
      return { stored, skipped: result.length - stored };
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      const isLockConflict = code === '40P01' || code === '40001';
      if (isLockConflict && attempt < MAX_ATTEMPTS) {
        logger.warn(
          { err, ticker, attempt, code },
          'fetch-gex-strike-expiry-etfs: lock conflict, retrying',
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      logger.warn(
        { err, ticker },
        'fetch-gex-strike-expiry-etfs: batch insert failed',
      );
      Sentry.captureException(err);
      return { stored: 0, skipped: filtered.length };
    }
  }
  // Unreachable: the loop above either returns or falls through to the
  // catch's return. Satisfies TS's control-flow analysis.
  return { stored: 0, skipped: filtered.length };
}

// ── Per-ticker orchestrator ───────────────────────────────────

async function processTicker(
  apiKey: string,
  ticker: EtfTicker,
  today: string,
): Promise<TickerResult> {
  const expiry = getPrimaryExpiry(ticker, today);

  const spotPrice = await fetchSpotPrice(apiKey, ticker);
  const rows = await withRetry(() =>
    fetchExpiryStrike(apiKey, ticker, expiry, spotPrice),
  );

  if (rows.length === 0) {
    return { ticker, stored: 0, skipped: 0, total: 0 };
  }

  const { stored, skipped } = await withRetry(() =>
    storeStrikes(rows, ticker, expiry, spotPrice),
  );

  return { ticker, stored, skipped, total: rows.length };
}

// ── Handler ───────────────────────────────────────────────────

export default withCronInstrumentation(
  'fetch-gex-strike-expiry-etfs',
  async (ctx): Promise<CronResult> => {
    const { apiKey, today, startTimeMs } = ctx;
    await cronJitter();

    const results = await Promise.allSettled(
      TICKERS.map((ticker) => processTicker(apiKey, ticker, today)),
    );

    const tickerResults: TickerResult[] = [];
    let totalStored = 0;
    let totalSkipped = 0;
    let failureCount = 0;

    for (let i = 0; i < results.length; i++) {
      const outcome = results[i]!;
      const ticker = TICKERS[i]!;
      if (outcome.status === 'fulfilled') {
        tickerResults.push(outcome.value);
        totalStored += outcome.value.stored;
        totalSkipped += outcome.value.skipped;
      } else {
        failureCount += 1;
        const errMsg =
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason);
        tickerResults.push({
          ticker,
          stored: 0,
          skipped: 0,
          total: 0,
          error: errMsg,
        });
        Sentry.captureException(outcome.reason);
        logger.error(
          { err: outcome.reason, ticker },
          'fetch-gex-strike-expiry-etfs: ticker failed',
        );
      }
    }

    const allFailed = failureCount === TICKERS.length;
    const status = allFailed
      ? 'error'
      : failureCount > 0
        ? 'partial'
        : 'success';

    logger.info(
      {
        tickers: tickerResults,
        totalStored,
        totalSkipped,
        failureCount,
        date: today,
        durationMs: Date.now() - startTimeMs,
      },
      'fetch-gex-strike-expiry-etfs completed',
    );

    return {
      status,
      rows: totalStored,
      metadata: {
        tickers: tickerResults,
        totalStored,
        totalSkipped,
        failureCount,
        durationMs: Date.now() - startTimeMs,
      },
    };
  },
);
