/**
 * GET /api/cron/fetch-strike-exposure
 *
 * Fetches per-strike Greek exposure for the four cross-asset zero-gamma
 * tickers (SPX, NDX, SPY, QQQ) from the Unusual Whales spot-exposures
 * endpoint. Results land in `strike_exposures` keyed by (date, timestamp,
 * ticker, strike, expiry). Downstream consumers — compute-zero-gamma,
 * gamma-squeeze, build-features-gex — filter by `ticker` and `expiry`.
 *
 * Per-ticker expiry policy:
 *   - SPX: today (0DTE) + tomorrow (1DTE). The 1DTE pull is preserved
 *     for the Periscope view and the build-features-gex 1DTE column.
 *   - SPY/QQQ: today (0DTE). Both have daily expirations.
 *   - NDX: front Mon/Wed/Fri expiration (today if Mon/Wed/Fri, else +1).
 *     NDX does not have daily expirations.
 *
 * Per-ticker ATM window:
 *   - SPX  ±200 pts (~80 strikes at $5)
 *   - NDX  ±500 pts (~3% of ~18k)
 *   - SPY  ±20 pts (~3% of ~600)
 *   - QQQ  ±20 pts (~3% of ~500)
 *
 * Total UW calls per invocation: 5 (SPX × 2, plus 1 each for NDX, SPY, QQQ).
 * All five run in parallel with per-task fault isolation via
 * Promise.allSettled — one ticker hiccup does not block the others.
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import {
  uwFetch,
  roundTo5Min,
  cronGuard,
  checkDataQuality,
  withRetry,
} from '../_lib/api-helpers.js';
import { reportCronRun } from '../_lib/axiom.js';
import {
  ZERO_GAMMA_TICKERS,
  getPrimaryExpiry,
  type ZeroGammaTicker,
} from '../_lib/zero-gamma-tickers.js';

// ── Ticker config ───────────────────────────────────────────

type Ticker = ZeroGammaTicker;

const ATM_RANGE_BY_TICKER: Record<Ticker, number> = {
  SPX: 200,
  NDX: 500,
  SPY: 20,
  QQQ: 20,
};

// ── Helpers ─────────────────────────────────────────────────

/** Get the next trading day (skip weekends) in YYYY-MM-DD format. */
function getNextTradingDay(today: string): string {
  const d = new Date(`${today}T12:00:00`);
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Per-ticker expiry list. SPX keeps the dual-expiry (0DTE + 1DTE) pull
 * because Periscope and build-features-gex still depend on the 1DTE rows.
 * Other tickers fetch only their primary (zero-gamma) expiry.
 */
function getExpiriesToFetch(ticker: Ticker, today: string): string[] {
  if (ticker === 'SPX') {
    return [today, getNextTradingDay(today)];
  }
  return [getPrimaryExpiry(ticker, today)];
}

// ── Types ───────────────────────────────────────────────────

interface StrikeRow {
  strike: string;
  price: string;
  time: string;
  date: string;
  expiry?: string;
  call_gamma_oi: string;
  put_gamma_oi: string;
  call_gamma_ask: string;
  call_gamma_bid: string;
  put_gamma_ask: string;
  put_gamma_bid: string;
  call_charm_oi: string;
  put_charm_oi: string;
  call_charm_ask: string;
  call_charm_bid: string;
  put_charm_ask: string;
  put_charm_bid: string;
  call_delta_oi: string;
  put_delta_oi: string;
  call_vanna_oi: string;
  put_vanna_oi: string;
}

interface ExpiryResult {
  total: number;
  stored: number;
  skipped: number;
}

// ── Fetch helper ────────────────────────────────────────────

async function fetchStrikeExposure(
  apiKey: string,
  ticker: Ticker,
  expiry: string,
): Promise<StrikeRow[]> {
  const params = new URLSearchParams({
    'expirations[]': expiry,
    limit: '500',
  });

  return uwFetch<StrikeRow>(
    apiKey,
    `/stock/${ticker}/spot-exposures/expiry-strike?${params}`,
  );
}

// ── Store helper ────────────────────────────────────────────

async function storeStrikes(
  rows: StrikeRow[],
  today: string,
  ticker: Ticker,
  expiry: string,
): Promise<ExpiryResult> {
  if (rows.length === 0) return { total: 0, stored: 0, skipped: 0 };

  const atmRange = ATM_RANGE_BY_TICKER[ticker];
  const price = Number.parseFloat(rows[0]!.price);
  const minStrike = price - atmRange;
  const maxStrike = price + atmRange;

  const filtered = rows.filter((r) => {
    const s = Number.parseFloat(r.strike);
    return s >= minStrike && s <= maxStrike;
  });

  if (filtered.length === 0) {
    return { total: rows.length, stored: 0, skipped: 0 };
  }

  const timestamp = roundTo5Min(new Date(rows[0]!.time)).toISOString();
  const sql = getDb();

  try {
    const results = await sql.transaction((txn) =>
      filtered.map(
        (row) => txn`
          INSERT INTO strike_exposures (
            date, timestamp, ticker, expiry, strike, price,
            call_gamma_oi, put_gamma_oi,
            call_gamma_ask, call_gamma_bid, put_gamma_ask, put_gamma_bid,
            call_charm_oi, put_charm_oi,
            call_charm_ask, call_charm_bid, put_charm_ask, put_charm_bid,
            call_delta_oi, put_delta_oi,
            call_vanna_oi, put_vanna_oi
          )
          VALUES (
            ${today}, ${timestamp}, ${ticker}, ${expiry}, ${row.strike}, ${row.price},
            ${row.call_gamma_oi}, ${row.put_gamma_oi},
            ${row.call_gamma_ask}, ${row.call_gamma_bid},
            ${row.put_gamma_ask}, ${row.put_gamma_bid},
            ${row.call_charm_oi}, ${row.put_charm_oi},
            ${row.call_charm_ask}, ${row.call_charm_bid},
            ${row.put_charm_ask}, ${row.put_charm_bid},
            ${row.call_delta_oi}, ${row.put_delta_oi},
            ${row.call_vanna_oi}, ${row.put_vanna_oi}
          )
          ON CONFLICT (date, timestamp, ticker, strike, expiry) DO NOTHING
          RETURNING id
        `,
      ),
    );

    let stored = 0;
    for (const result of results) {
      if (result.length > 0) stored++;
    }
    return {
      total: rows.length,
      stored,
      skipped: filtered.length - stored,
    };
  } catch (err) {
    Sentry.captureException(err);
    logger.warn({ err, ticker, expiry }, 'Batch strike exposure insert failed');
    return { total: rows.length, stored: 0, skipped: filtered.length };
  }
}

// ── Per-task runner ─────────────────────────────────────────

interface TaskOutcome {
  ticker: Ticker;
  expiry: string;
  result: ExpiryResult;
  price: number | null;
}

async function runOne(
  apiKey: string,
  today: string,
  ticker: Ticker,
  expiry: string,
): Promise<TaskOutcome> {
  const rows = await withRetry(() =>
    fetchStrikeExposure(apiKey, ticker, expiry),
  );
  const price = rows.length > 0 ? Number.parseFloat(rows[0]!.price) : null;
  const result = await withRetry(() =>
    storeStrikes(rows, today, ticker, expiry),
  );
  return { ticker, expiry, result, price };
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res);
  if (!guard) return;
  const { apiKey, today } = guard;

  const startTime = Date.now();

  // Build the (ticker, expiry) task list
  const tasks: Array<{ ticker: Ticker; expiry: string }> = [];
  for (const ticker of ZERO_GAMMA_TICKERS) {
    for (const expiry of getExpiriesToFetch(ticker, today)) {
      tasks.push({ ticker, expiry });
    }
  }

  try {
    // Run all tasks in parallel; isolate failures so one ticker hiccup
    // does not block the rest.
    const settled = await Promise.allSettled(
      tasks.map((t) => runOne(apiKey, today, t.ticker, t.expiry)),
    );

    // Per-ticker aggregation
    const perTicker: Record<
      string,
      {
        price: number | null;
        expiries: Record<string, ExpiryResult>;
        totalStored: number;
        totalSkipped: number;
      }
    > = {};

    for (const ticker of ZERO_GAMMA_TICKERS) {
      perTicker[ticker] = {
        price: null,
        expiries: {},
        totalStored: 0,
        totalSkipped: 0,
      };
    }

    let anySuccess = false;
    settled.forEach((s, i) => {
      const task = tasks[i]!;
      const bucket = perTicker[task.ticker]!;

      if (s.status === 'fulfilled') {
        anySuccess = true;
        bucket.expiries[task.expiry] = s.value.result;
        bucket.totalStored += s.value.result.stored;
        bucket.totalSkipped += s.value.result.skipped;
        if (s.value.price != null) bucket.price = s.value.price;
      } else {
        Sentry.setTag('cron.job', 'fetch-strike-exposure');
        Sentry.setTag('ticker', task.ticker);
        Sentry.captureException(s.reason);
        logger.error(
          { err: s.reason, ticker: task.ticker, expiry: task.expiry },
          'fetch-strike-exposure: per-task failure',
        );
        bucket.expiries[task.expiry] = { total: 0, stored: 0, skipped: 0 };
      }
    });

    if (!anySuccess) {
      logger.error('fetch-strike-exposure: all tasks failed');
      return res.status(500).json({ error: 'All ticker fetches failed' });
    }

    // Data quality check on the primary expiry per ticker (skip if no rows
    // were stored — avoids spurious "all-zero" alerts on first run of day).
    for (const ticker of ZERO_GAMMA_TICKERS) {
      const primary = getPrimaryExpiry(ticker, today);
      const stored = perTicker[ticker]!.expiries[primary]?.stored ?? 0;
      if (stored < 10) continue;

      const qcRows = await getDb()`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (
                 WHERE call_gamma_oi::numeric != 0 OR put_gamma_oi::numeric != 0
               ) AS nonzero
        FROM strike_exposures
        WHERE date = ${today}
          AND ticker = ${ticker}
          AND expiry = ${primary}
      `;
      const { total, nonzero } = qcRows[0]!;
      await checkDataQuality({
        job: 'fetch-strike-exposure',
        table: 'strike_exposures',
        date: today,
        sourceFilter: `ticker=${ticker} expiry=${primary}`,
        total: Number(total),
        nonzero: Number(nonzero),
      });
    }

    const totalStored = Object.values(perTicker).reduce(
      (a, b) => a + b.totalStored,
      0,
    );
    const totalSkipped = Object.values(perTicker).reduce(
      (a, b) => a + b.totalSkipped,
      0,
    );
    const durationMs = Date.now() - startTime;

    logger.info(
      { perTicker, totalStored, totalSkipped, date: today, durationMs },
      'fetch-strike-exposure completed',
    );

    await reportCronRun('fetch-strike-exposure', {
      status: 'ok',
      perTicker,
      totalStored,
      totalSkipped,
      durationMs,
    });

    return res.status(200).json({
      job: 'fetch-strike-exposure',
      success: true,
      perTicker,
      totalStored,
      totalSkipped,
      durationMs,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-strike-exposure');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-strike-exposure error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
