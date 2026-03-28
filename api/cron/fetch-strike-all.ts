/**
 * GET /api/cron/fetch-strike-all
 *
 * Fetches per-strike Greek exposure for SPX across ALL expirations
 * from Unusual Whales API.
 *
 * This complements the 0DTE-only fetch-strike-exposure cron by providing
 * the aggregate gamma/charm landscape across all expirations. Useful for:
 *   - Identifying multi-day gamma walls that anchor price beyond 0DTE
 *   - Seeing where monthly/quarterly expiration gamma concentrates
 *   - Comparing 0DTE-specific walls against the all-expiry backdrop
 *
 * Stores in the same strike_exposures table with expiry = '1970-01-01' as a
 * sentinel value to distinguish from 0DTE rows (which have expiry = today's date).
 * This avoids PostgreSQL's NULL != NULL behavior in UNIQUE constraints.
 *
 * Stores strikes within ±200 pts of ATM.
 *
 * Total API calls per invocation: 1
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { TIMEOUTS } from '../_lib/constants.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { isMarketHours, withRetry } from '../_lib/api-helpers.js';

const UW_BASE = 'https://api.unusualwhales.com/api';
const ATM_RANGE = 200;
const ALL_EXPIRY_SENTINEL = '1970-01-01';

function getTodayET(): string {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  });
}

// ── Types ───────────────────────────────────────────────────

interface StrikeRow {
  strike: string;
  price: string;
  time: string;
  date: string;
  ticker: string;
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

async function fetchStrikeAll(apiKey: string): Promise<StrikeRow[]> {
  const res = await fetch(
    `${UW_BASE}/stock/SPX/spot-exposures/strike?limit=500`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(TIMEOUTS.UW_API),
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`UW API ${res.status}: ${text.slice(0, 200)}`);
  }

  const body = await res.json();
  return body.data ?? [];
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

  // Round timestamp to 5-min
  const dataTime = new Date(rows[0]!.time);
  const minutes = dataTime.getMinutes();
  dataTime.setMinutes(minutes - (minutes % 5), 0, 0);
  const timestamp = dataTime.toISOString();

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
            ${today}, ${timestamp}, 'SPX', ${ALL_EXPIRY_SENTINEL}, ${row.strike}, ${row.price},
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
    logger.warn({ err }, 'Batch all-expiry strike insert failed');
    return { stored: 0, skipped: filtered.length };
  }
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!isMarketHours()) {
    return res
      .status(200)
      .json({ skipped: true, reason: 'Outside market hours' });
  }

  const startTime = Date.now();
  const apiKey = process.env.UW_API_KEY;
  if (!apiKey) {
    logger.error('UW_API_KEY not configured');
    return res.status(500).json({ error: 'UW_API_KEY not configured' });
  }

  const today = getTodayET();

  try {
    const rows = await withRetry(() => fetchStrikeAll(apiKey));

    if (rows.length === 0) {
      return res.status(200).json({ stored: false, reason: 'No strike data' });
    }

    const price = Number.parseFloat(rows[0]!.price);
    const result = await withRetry(() => storeStrikes(rows, today));

    logger.info(
      {
        totalStrikes: rows.length,
        stored: result.stored,
        skipped: result.skipped,
        price,
        date: today,
      },
      'fetch-strike-all completed',
    );

    return res.status(200).json({
      job: 'fetch-strike-all',
      success: true,
      price,
      totalStrikes: rows.length,
      ...result,
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-strike-all');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-strike-all error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
