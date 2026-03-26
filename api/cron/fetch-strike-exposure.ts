/**
 * GET /api/cron/fetch-strike-exposure
 *
 * Fetches per-strike Greek exposure for SPX 0DTE from Unusual Whales API.
 * Uses the expiry-strike endpoint filtered to today's expiration.
 *
 * This replaces the Net Charm (naive) screenshot:
 *   - Net gamma per strike (call_gamma_oi + put_gamma_oi) = naive gamma profile
 *   - Net charm per strike (call_charm_oi + put_charm_oi) = naive charm profile
 *   - Ask/bid breakdown approximates directionalized exposure
 *
 * Stores strikes within ±200 pts of ATM (about 80 strikes at $5 intervals).
 * Only stores the latest snapshot per cron invocation — builds time series over the day.
 *
 * Total API calls per invocation: 1
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';

const UW_BASE = 'https://api.unusualwhales.com/api';
const ATM_RANGE = 200; // ±200 pts from ATM

// ── Market hours check ──────────────────────────────────────

function isMarketHours(): boolean {
  const now = new Date();
  const et = new Date(
    now.toLocaleString('en-US', { timeZone: 'America/New_York' }),
  );
  const day = et.getDay();
  if (day === 0 || day === 6) return false;

  const hour = et.getHours();
  const minute = et.getMinutes();
  const timeMinutes = hour * 60 + minute;

  return timeMinutes >= 565 && timeMinutes <= 965;
}

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
  today: string,
): Promise<StrikeRow[]> {
  const params = new URLSearchParams({
    'expirations[]': today,
    limit: '500',
  });

  const res = await fetch(
    `${UW_BASE}/stock/SPX/spot-exposures/expiry-strike?${params}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
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

  // Determine ATM from price field
  const price = Number.parseFloat(rows[0]!.price);
  const minStrike = price - ATM_RANGE;
  const maxStrike = price + ATM_RANGE;

  // Filter to ATM range
  const filtered = rows.filter((r) => {
    const s = Number.parseFloat(r.strike);
    return s >= minStrike && s <= maxStrike;
  });

  // Use the timestamp from the data, rounded to 5-min
  const dataTime = new Date(rows[0]!.time);
  const minutes = dataTime.getMinutes();
  dataTime.setMinutes(minutes - (minutes % 5), 0, 0);
  const timestamp = dataTime.toISOString();

  const sql = getDb();
  let stored = 0;
  let skipped = 0;

  for (const row of filtered) {
    try {
      const result = await sql`
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
          ${today}, ${timestamp}, 'SPX', ${today}, ${row.strike}, ${row.price},
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
      `;
      if (result.length > 0) stored++;
      else skipped++;
    } catch (err) {
      logger.warn({ err, strike: row.strike }, 'Strike exposure insert failed');
      skipped++;
    }
  }

  return { stored, skipped };
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

  const apiKey = process.env.UW_API_KEY;
  if (!apiKey) {
    logger.error('UW_API_KEY not configured');
    return res.status(500).json({ error: 'UW_API_KEY not configured' });
  }

  const today = getTodayET();

  try {
    const rows = await fetchStrikeExposure(apiKey, today);

    if (rows.length === 0) {
      return res
        .status(200)
        .json({ stored: false, reason: 'No 0DTE strike data' });
    }

    const price = Number.parseFloat(rows[0]!.price);
    const result = await storeStrikes(rows, today);

    logger.info(
      {
        totalStrikes: rows.length,
        filteredStrikes: result.stored + result.skipped,
        stored: result.stored,
        skipped: result.skipped,
        price,
        date: today,
      },
      'fetch-strike-exposure completed',
    );

    return res.status(200).json({
      success: true,
      price,
      totalStrikes: rows.length,
      ...result,
    });
  } catch (err) {
    logger.error({ err }, 'fetch-strike-exposure error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
