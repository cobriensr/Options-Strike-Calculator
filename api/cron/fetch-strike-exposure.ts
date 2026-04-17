/**
 * GET /api/cron/fetch-strike-exposure
 *
 * Fetches per-strike Greek exposure for SPX 0DTE and 1DTE from Unusual Whales API.
 * Uses the expiry-strike endpoint filtered to today's and tomorrow's expiration.
 *
 * This replaces the Net Charm (naive) screenshot:
 *   - Net gamma per strike (call_gamma_oi + put_gamma_oi) = naive gamma profile
 *   - Net charm per strike (call_charm_oi + put_charm_oi) = naive charm profile
 *   - Ask/bid breakdown approximates directionalized exposure
 *
 * Stores strikes within ±200 pts of ATM (about 80 strikes at $5 intervals).
 * Only stores the latest snapshot per cron invocation — builds time series over the day.
 *
 * Total API calls per invocation: 2 (0DTE + 1DTE)
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

const ATM_RANGE = 200; // ±200 pts from ATM

// ── Helpers ─────────────────────────────────────────────────

/** Get the next trading day (skip weekends) in YYYY-MM-DD format. */
function getNextTradingDay(today: string): string {
  const d = new Date(`${today}T12:00:00`);
  d.setDate(d.getDate() + 1);
  // Skip Saturday (6) and Sunday (0)
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d.toISOString().slice(0, 10);
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

// ── Fetch helper ────────────────────────────────────────────

async function fetchStrikeExposure(
  apiKey: string,
  expiry: string,
): Promise<StrikeRow[]> {
  const params = new URLSearchParams({
    'expirations[]': expiry,
    limit: '500',
  });

  return uwFetch<StrikeRow>(
    apiKey,
    `/stock/SPX/spot-exposures/expiry-strike?${params}`,
  );
}

// ── Store helper ────────────────────────────────────────────

async function storeStrikes(
  rows: StrikeRow[],
  today: string,
  expiry: string,
): Promise<{ stored: number; skipped: number }> {
  if (rows.length === 0) return { stored: 0, skipped: 0 };

  // Determine ATM from price field
  const price = Number.parseFloat(rows[0]!.price);
  const minStrike = price - ATM_RANGE;
  const maxStrike = price + ATM_RANGE;

  // Filter to ATM range
  const filtered = rows.filter((r) => {
    const s = Number.parseFloat(r.strike);
    return s >= minStrike && s <= maxStrike;
  });

  if (filtered.length === 0) return { stored: 0, skipped: 0 };

  // Use the timestamp from the data, rounded to 5-min
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
            ${today}, ${timestamp}, 'SPX', ${expiry}, ${row.strike}, ${row.price},
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
    return { stored, skipped: filtered.length - stored };
  } catch (err) {
    Sentry.captureException(err);
    logger.warn({ err }, 'Batch strike exposure insert failed');
    return { stored: 0, skipped: filtered.length };
  }
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res);
  if (!guard) return;
  const { apiKey, today } = guard;

  const startTime = Date.now();
  const tomorrow = getNextTradingDay(today);

  try {
    // Fetch 0DTE and 1DTE in parallel
    const [rows0dte, rows1dte] = await Promise.all([
      withRetry(() => fetchStrikeExposure(apiKey, today)),
      withRetry(() => fetchStrikeExposure(apiKey, tomorrow)),
    ]);

    if (rows0dte.length === 0 && rows1dte.length === 0) {
      return res.status(200).json({ stored: false, reason: 'No strike data' });
    }

    const price = Number.parseFloat((rows0dte[0] ?? rows1dte[0])!.price);

    // Store both expiries
    const [result0dte, result1dte] = await Promise.all([
      rows0dte.length > 0
        ? withRetry(() => storeStrikes(rows0dte, today, today))
        : { stored: 0, skipped: 0 },
      rows1dte.length > 0
        ? withRetry(() => storeStrikes(rows1dte, today, tomorrow))
        : { stored: 0, skipped: 0 },
    ]);

    logger.info(
      {
        dte0: {
          total: rows0dte.length,
          stored: result0dte.stored,
          skipped: result0dte.skipped,
        },
        dte1: {
          total: rows1dte.length,
          stored: result1dte.stored,
          skipped: result1dte.skipped,
        },
        price,
        date: today,
      },
      'fetch-strike-exposure completed',
    );

    // Data quality check for 0DTE
    if (result0dte.stored > 10) {
      const qcRows = await getDb()`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (
                 WHERE call_gamma_oi::numeric != 0 OR put_gamma_oi::numeric != 0
               ) AS nonzero
        FROM strike_exposures
        WHERE date = ${today} AND expiry = ${today}
      `;
      const { total, nonzero } = qcRows[0]!;
      await checkDataQuality({
        job: 'fetch-strike-exposure',
        table: 'strike_exposures',
        date: today,
        sourceFilter: 'expiry = today (0DTE)',
        total: Number(total),
        nonzero: Number(nonzero),
      });
    }

    const totalStored = result0dte.stored + result1dte.stored;
    const totalSkipped = result0dte.skipped + result1dte.skipped;
    const durationMs = Date.now() - startTime;

    await reportCronRun('fetch-strike-exposure', {
      status: 'ok',
      price,
      dte0: result0dte,
      dte1: result1dte,
      totalStored,
      totalSkipped,
      durationMs,
    });

    return res.status(200).json({
      job: 'fetch-strike-exposure',
      success: true,
      price,
      dte0: result0dte,
      dte1: result1dte,
      totalStored,
      totalSkipped,
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-strike-exposure');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-strike-exposure error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
