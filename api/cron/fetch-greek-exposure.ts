/**
 * GET /api/cron/fetch-greek-exposure
 *
 * Fetches Greek Exposure for SPX from Unusual Whales API.
 * Two calls per invocation:
 *   1. Aggregate endpoint → OI Net Gamma (Rule 16), charm, delta, vanna
 *   2. By-expiry endpoint → charm/delta/vanna breakdown per expiration (gamma is null on basic tier)
 *
 * The aggregate row is stored with expiry=date and dte=-1.
 * The 0DTE by-expiry row is stored with expiry=date and dte=0.
 * The UNIQUE constraint on (date, ticker, expiry, dte) allows both to coexist.
 *
 * Data is OI-based (changes once per day), so duplicate cron runs are skipped.
 *
 * Total API calls per invocation: 2
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

interface AggregateRow {
  date: string;
  call_gamma: string;
  put_gamma: string;
  call_charm: string;
  put_charm: string;
  call_delta: string;
  put_delta: string;
  call_vanna: string;
  put_vanna: string;
}

interface ExpiryRow {
  date: string;
  expiry: string;
  dte: number;
  call_gamma: string | null;
  put_gamma: string | null;
  call_charm: string;
  put_charm: string;
  call_delta: string;
  put_delta: string;
  call_vanna: string;
  put_vanna: string;
}

// ── Fetch helpers ───────────────────────────────────────────

async function fetchAggregate(apiKey: string): Promise<AggregateRow[]> {
  const res = await fetch(`${UW_BASE}/stock/SPX/greek-exposure`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`UW aggregate API ${res.status}: ${text.slice(0, 200)}`);
  }

  const body = await res.json();
  return body.data ?? [];
}

async function fetchByExpiry(apiKey: string): Promise<ExpiryRow[]> {
  const res = await fetch(`${UW_BASE}/stock/SPX/greek-exposure/expiry`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`UW expiry API ${res.status}: ${text.slice(0, 200)}`);
  }

  const body = await res.json();
  return body.data ?? [];
}

// ── Store helpers ───────────────────────────────────────────

async function storeAggregate(row: AggregateRow): Promise<boolean> {
  const sql = getDb();
  const result = await sql`
    INSERT INTO greek_exposure (
      date, ticker, expiry, dte,
      call_gamma, put_gamma, call_charm, put_charm,
      call_delta, put_delta, call_vanna, put_vanna
    )
    VALUES (
      ${row.date}, 'SPX', ${row.date}, -1,
      ${row.call_gamma}, ${row.put_gamma},
      ${row.call_charm}, ${row.put_charm},
      ${row.call_delta}, ${row.put_delta},
      ${row.call_vanna}, ${row.put_vanna}
    )
    ON CONFLICT (date, ticker, expiry, dte) DO UPDATE SET
      call_gamma = EXCLUDED.call_gamma,
      put_gamma = EXCLUDED.put_gamma
    RETURNING id
  `;
  return result.length > 0;
}

async function storeExpiryRows(
  rows: ExpiryRow[],
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
        ON CONFLICT (date, ticker, expiry, dte) DO NOTHING
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

  try {
    const [aggRows, expiryRows] = await Promise.all([
      fetchAggregate(apiKey),
      fetchByExpiry(apiKey),
    ]);

    let aggStored = false;
    if (aggRows.length > 0) {
      const latest = aggRows.at(-1)!;
      aggStored = await storeAggregate(latest);

      const netGamma =
        Number.parseFloat(latest.call_gamma) +
        Number.parseFloat(latest.put_gamma);
      logger.info(
        {
          date: latest.date,
          netGamma: Math.round(netGamma),
          stored: aggStored,
        },
        'Aggregate GEX stored',
      );
    }

    const expiryResult = await storeExpiryRows(expiryRows);

    logger.info(
      {
        aggregate: aggStored,
        expiries: expiryRows.length,
        expiryStored: expiryResult.stored,
        expirySkipped: expiryResult.skipped,
      },
      'fetch-greek-exposure completed',
    );

    return res.status(200).json({
      aggregateStored: aggStored,
      expiries: expiryRows.length,
      ...expiryResult,
    });
  } catch (err) {
    logger.error({ err }, 'fetch-greek-exposure error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
