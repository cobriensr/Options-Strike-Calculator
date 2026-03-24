/**
 * GET /api/cron/fetch-greek-exposure
 *
 * Fetches Greek Exposure by Expiry for SPX from Unusual Whales API.
 * Returns MM gamma, charm, delta, vanna exposure broken down by expiration date.
 *
 * This replaces the Aggregate GEX screenshot:
 *   - Sum all expiries → OI Net Gamma Exposure (Rule 16)
 *   - Filter to today's expiry → 0DTE-specific exposure
 *   - Percentage breakdown → how much of the regime is 0DTE vs longer-dated
 *
 * NOTE: This endpoint returns OI-based Greek exposure (updated daily from
 * open interest). Volume GEX (intraday) is NOT available from this endpoint.
 * Volume GEX still requires the Aggregate GEX screenshot.
 *
 * Data changes once per day (based on prior day's OI), so fetching every
 * 5 minutes is safe — ON CONFLICT skips duplicates.
 *
 * Total API calls per invocation: 1
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';

const UW_BASE = 'https://api.unusualwhales.com/api';

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

// ── Types ───────────────────────────────────────────────────

interface GreekExpiryRow {
  call_charm: string;
  call_delta: string;
  call_gamma: string;
  call_vanna: string;
  date: string;
  dte: number;
  expiry: string;
  put_charm: string;
  put_delta: string;
  put_gamma: string;
  put_vanna: string;
}

// ── Fetch helper ────────────────────────────────────────────

async function fetchGreekExposure(apiKey: string): Promise<GreekExpiryRow[]> {
  const res = await fetch(`${UW_BASE}/stock/SPX/greek-exposure/expiry`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`UW API ${res.status}: ${text.slice(0, 200)}`);
  }

  const body = await res.json();
  return body.data ?? [];
}

// ── Store helper ────────────────────────────────────────────

async function storeExpiryRows(
  rows: GreekExpiryRow[],
): Promise<{ stored: number; skipped: number }> {
  if (rows.length === 0) return { stored: 0, skipped: 0 };

  const sql = getDb();
  let stored = 0;
  let skipped = 0;

  for (const row of rows) {
    try {
      const result = await sql`
        INSERT INTO greek_exposure (
          date, ticker, expiry, dte,
          call_gamma, put_gamma, call_charm, put_charm,
          call_delta, put_delta, call_vanna, put_vanna
        )
        VALUES (
          ${row.date}, 'SPX', ${row.expiry}, ${row.dte},
          ${row.call_gamma}, ${row.put_gamma},
          ${row.call_charm}, ${row.put_charm},
          ${row.call_delta}, ${row.put_delta},
          ${row.call_vanna}, ${row.put_vanna}
        )
        ON CONFLICT (date, ticker, expiry) DO NOTHING
        RETURNING id
      `;
      if (result.length > 0) stored++;
      else skipped++;
    } catch (err) {
      logger.warn({ err, expiry: row.expiry }, 'Greek exposure insert failed');
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
  const authHeader = req.headers.authorization;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
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

  try {
    const rows = await fetchGreekExposure(apiKey);
    const result = await storeExpiryRows(rows);

    // Compute summary for logging
    const zeroDte = rows.find((r) => r.date === r.expiry || r.dte === 0);
    const aggregateGamma = rows.reduce(
      (sum, r) =>
        sum + Number.parseFloat(r.call_gamma) + Number.parseFloat(r.put_gamma),
      0,
    );

    logger.info(
      {
        expiries: rows.length,
        stored: result.stored,
        skipped: result.skipped,
        aggregateGamma: Math.round(aggregateGamma),
        zeroDteGamma: zeroDte
          ? Math.round(
              Number.parseFloat(zeroDte.call_gamma) +
                Number.parseFloat(zeroDte.put_gamma),
            )
          : null,
      },
      'fetch-greek-exposure completed',
    );

    return res.status(200).json({
      ...result,
      expiries: rows.length,
      aggregateGamma: Math.round(aggregateGamma),
    });
  } catch (err) {
    logger.error({ err }, 'fetch-greek-exposure error');
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Fetch failed',
    });
  }
}
