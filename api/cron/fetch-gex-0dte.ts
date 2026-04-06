/**
 * GET /api/cron/fetch-gex-0dte
 *
 * Fetches per-strike Greek exposure for SPX 0DTE from Unusual Whales API
 * and stores it in the gex_strike_0dte table at the original timestamp
 * (no rounding — preserves minute precision from UW API).
 *
 * This powers the "0DTE GEX Per Strike" dashboard widget, storing:
 *   - OI-based gamma, charm, delta, vanna per strike
 *   - Volume-based gamma, charm, vanna (for vol vs OI reinforcement)
 *   - Directionalized gamma (bid/ask breakdown)
 *
 * Runs every 5 minutes during market hours (13-21 UTC, Mon-Fri).
 * Total API calls per invocation: 1 (0DTE only)
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import {
  uwFetch,
  cronGuard,
  checkDataQuality,
  withRetry,
} from '../_lib/api-helpers.js';

const ATM_RANGE = 200; // ±200 pts from ATM

// ── Types ───────────────────────────────────────────────────

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
  call_delta_oi: string;
  put_delta_oi: string;
  call_vanna_oi: string;
  put_vanna_oi: string;
  call_vanna_vol: string;
  put_vanna_vol: string;
}

// ── Fetch helper ────────────────────────────────────────────

async function fetchStrike0dte(
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
): Promise<{ stored: number; skipped: number }> {
  if (rows.length === 0) return { stored: 0, skipped: 0 };

  const price = Number.parseFloat(rows[0]!.price);
  const minStrike = price - ATM_RANGE;
  const maxStrike = price + ATM_RANGE;

  const filtered = rows.filter((r) => {
    const s = Number.parseFloat(r.strike);
    return s >= minStrike && s <= maxStrike;
  });

  if (filtered.length === 0) return { stored: 0, skipped: 0 };

  // Use original timestamp (no rounding — minute precision)
  const timestamp = new Date(rows[0]!.time).toISOString();

  const sql = getDb();

  try {
    const results = await sql.transaction((txn) =>
      filtered.map(
        (row) => txn`
          INSERT INTO gex_strike_0dte (
            date, timestamp, strike, price,
            call_gamma_oi, put_gamma_oi,
            call_gamma_vol, put_gamma_vol,
            call_gamma_ask, call_gamma_bid,
            put_gamma_ask, put_gamma_bid,
            call_charm_oi, put_charm_oi,
            call_charm_vol, put_charm_vol,
            call_delta_oi, put_delta_oi,
            call_vanna_oi, put_vanna_oi,
            call_vanna_vol, put_vanna_vol
          )
          VALUES (
            ${today}, ${timestamp}, ${row.strike}, ${row.price},
            ${row.call_gamma_oi}, ${row.put_gamma_oi},
            ${row.call_gamma_vol}, ${row.put_gamma_vol},
            ${row.call_gamma_ask}, ${row.call_gamma_bid},
            ${row.put_gamma_ask}, ${row.put_gamma_bid},
            ${row.call_charm_oi}, ${row.put_charm_oi},
            ${row.call_charm_vol}, ${row.put_charm_vol},
            ${row.call_delta_oi}, ${row.put_delta_oi},
            ${row.call_vanna_oi}, ${row.put_vanna_oi},
            ${row.call_vanna_vol}, ${row.put_vanna_vol}
          )
          ON CONFLICT (date, timestamp, strike) DO NOTHING
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
    logger.warn({ err }, 'Batch gex_strike_0dte insert failed');
    return { stored: 0, skipped: filtered.length };
  }
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res);
  if (!guard) return;
  const { apiKey, today } = guard;

  const startTime = Date.now();

  try {
    const rows = await withRetry(() => fetchStrike0dte(apiKey, today));

    if (rows.length === 0) {
      return res
        .status(200)
        .json({ stored: false, reason: 'No 0DTE strike data' });
    }

    const price = Number.parseFloat(rows[0]!.price);
    const result = await withRetry(() => storeStrikes(rows, today));

    logger.info(
      {
        total: rows.length,
        stored: result.stored,
        skipped: result.skipped,
        price,
        date: today,
      },
      'fetch-gex-0dte completed',
    );

    // Data quality check
    if (result.stored > 10) {
      const qcRows = await getDb()`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (
                 WHERE call_gamma_oi::numeric != 0
                    OR put_gamma_oi::numeric != 0
               ) AS nonzero
        FROM gex_strike_0dte
        WHERE date = ${today}
      `;
      const { total, nonzero } = qcRows[0]!;
      await checkDataQuality({
        job: 'fetch-gex-0dte',
        table: 'gex_strike_0dte',
        date: today,
        sourceFilter: '0DTE only',
        total: Number(total),
        nonzero: Number(nonzero),
      });
    }

    return res.status(200).json({
      job: 'fetch-gex-0dte',
      success: true,
      price,
      stored: result.stored,
      skipped: result.skipped,
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-gex-0dte');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-gex-0dte error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
