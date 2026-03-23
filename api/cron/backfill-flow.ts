/**
 * POST /api/cron/backfill-flow
 *
 * One-off endpoint to backfill historical Market Tide data from the UW API.
 * Fetches the last N trading days of 5-minute Market Tide data (all-in + OTM)
 * and stores in the flow_data table.
 *
 * Call once after deploying the flow_data migration:
 *   curl -X POST https://your-app.vercel.app/api/cron/backfill-flow \
 *     -H "Authorization: Bearer YOUR_CRON_SECRET"
 *
 * Safe to re-run — uses ON CONFLICT DO NOTHING so duplicates are skipped.
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';

// Allow plenty of time for 30 days × 2 API calls
export const config = { maxDuration: 300 };

const UW_BASE = 'https://api.unusualwhales.com/api';

// ── Generate trading days ───────────────────────────────────

function getTradingDays(count: number): string[] {
  const dates: string[] = [];
  const now = new Date();
  const d = new Date(now);

  while (dates.length < count) {
    d.setDate(d.getDate() - 1);
    const day = d.getDay();
    // Skip weekends
    if (day === 0 || day === 6) continue;
    // Format as YYYY-MM-DD
    const dateStr = d.toISOString().slice(0, 10);
    dates.push(dateStr);
  }

  return dates.reverse(); // oldest first
}

// ── Fetch + store helper ────────────────────────────────────

interface MarketTideRow {
  date: string;
  net_call_premium: string;
  net_put_premium: string;
  net_volume: number;
  timestamp: string;
}

async function fetchAndStore(
  apiKey: string,
  date: string,
  otmOnly: boolean,
): Promise<{ date: string; source: string; rows: number; stored: number }> {
  const source = otmOnly ? 'market_tide_otm' : 'market_tide';
  const params = new URLSearchParams({
    date,
    interval_5m: 'true',
  });
  if (otmOnly) params.set('otm_only', 'true');

  const res = await fetch(`${UW_BASE}/market/market-tide?${params}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.warn(
      { date, source, status: res.status, body: text.slice(0, 200) },
      'UW API error for date',
    );
    return { date, source, rows: 0, stored: 0 };
  }

  const body = await res.json();
  const data: MarketTideRow[] = body.data ?? [];

  if (data.length === 0) {
    return { date, source, rows: 0, stored: 0 };
  }

  const sql = getDb();
  let stored = 0;

  // Batch insert all candles for this day
  for (const row of data) {
    try {
      const result = await sql`
        INSERT INTO flow_data (date, timestamp, source, ncp, npp, net_volume)
        VALUES (
          ${row.date},
          ${row.timestamp},
          ${source},
          ${row.net_call_premium},
          ${row.net_put_premium},
          ${row.net_volume}
        )
        ON CONFLICT (date, timestamp, source) DO NOTHING
        RETURNING id
      `;
      if (result.length > 0) stored++;
    } catch (err) {
      logger.warn(
        { err, date, source, timestamp: row.timestamp },
        'Row insert failed',
      );
    }
  }

  return { date, source, rows: data.length, stored };
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  // Verify cron secret
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apiKey = process.env.UW_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'UW_API_KEY not configured' });
  }

  // How many trading days to backfill (default 30, max 30 for basic tier)
  const daysParam = Number(req.query.days ?? 30);
  const days = Math.min(Math.max(1, daysParam), 30);

  const tradingDays = getTradingDays(days);
  logger.info(
    { days, tradingDays: tradingDays.length },
    'Starting flow backfill',
  );

  const results: Array<{
    date: string;
    source: string;
    rows: number;
    stored: number;
  }> = [];

  // Process days sequentially to avoid rate limiting
  for (const date of tradingDays) {
    // Small delay between dates to be respectful of API rate limits
    await new Promise((r) => setTimeout(r, 200));

    const [allIn, otm] = await Promise.all([
      fetchAndStore(apiKey, date, false),
      fetchAndStore(apiKey, date, true),
    ]);

    results.push(allIn, otm);

    logger.info(
      {
        date,
        allIn: { rows: allIn.rows, stored: allIn.stored },
        otm: { rows: otm.rows, stored: otm.stored },
      },
      'Backfilled date',
    );
  }

  const totalRows = results.reduce((sum, r) => sum + r.rows, 0);
  const totalStored = results.reduce((sum, r) => sum + r.stored, 0);
  const totalSkipped = totalRows - totalStored;

  const summary = {
    daysProcessed: tradingDays.length,
    totalCandles: totalRows,
    newlyStored: totalStored,
    duplicatesSkipped: totalSkipped,
    dateRange: {
      from: tradingDays[0],
      to: tradingDays.at(-1),
    },
  };

  logger.info(summary, 'Backfill complete');
  return res.status(200).json(summary);
}
