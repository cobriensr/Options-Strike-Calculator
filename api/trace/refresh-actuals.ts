import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';

interface DayPrices {
  open: number;
  close: number;
}

/**
 * Fetch SPX open/close prices from Stooq.
 *
 * Stooq returns a plain CSV (no auth, no crumb):
 *   Date,Open,High,Low,Close,Volume
 *   2026-01-16,5862.19,5953.68,5862.19,5937.34,0
 *
 * Using Stooq instead of Yahoo Finance to avoid Yahoo's crumb/cookie
 * authentication flow which breaks in serverless environments.
 */
async function fetchSpxPrices(
  dates: string[],
): Promise<Map<string, DayPrices>> {
  const sorted = [...dates].sort((a, b) => a.localeCompare(b));

  // Pad 5 days before/after to ensure we catch every requested date
  const start = new Date(`${sorted[0]}T12:00:00Z`);
  start.setDate(start.getDate() - 5);
  const end = new Date(`${sorted.at(-1)!}T12:00:00Z`);
  end.setDate(end.getDate() + 2);
  const d1padded = start.toISOString().slice(0, 10).replaceAll('-', '');
  const d2padded = end.toISOString().slice(0, 10).replaceAll('-', '');

  const url = `https://stooq.com/q/d/l/?s=%5ESPX&d1=${d1padded}&d2=${d2padded}&i=d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/csv' },
  });
  if (!res.ok) throw new Error(`Stooq returned ${res.status}`);

  const csv = await res.text();

  // Log the raw response so we can diagnose symbol/format issues in Vercel logs
  logger.info(
    { url, statusCode: res.status, csvPreview: csv.slice(0, 300) },
    'Stooq CSV response',
  );

  const priceMap = new Map<string, DayPrices>();

  for (const line of csv.split('\n').slice(1)) {
    const parts = line.trim().split(',');
    if (parts.length < 5) continue;
    const [date, openStr, , , closeStr] = parts;
    const open = Number.parseFloat(openStr ?? '');
    const close = Number.parseFloat(closeStr ?? '');
    if (date && Number.isFinite(open) && Number.isFinite(close)) {
      priceMap.set(date, {
        open: Math.round(open * 100) / 100,
        close: Math.round(close * 100) / 100,
      });
    }
  }

  logger.info(
    { dates, priceMapKeys: [...priceMap.keys()] },
    'Stooq price map built',
  );

  return priceMap;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const sql = getDb();

  try {
    // Fetch rows missing actual_close OR current_price so both get filled in one pass
    const rows = (await sql`
      SELECT date::text FROM trace_predictions
      WHERE actual_close IS NULL OR current_price IS NULL
      ORDER BY date
    `) as { date: string }[];

    if (rows.length === 0) {
      res.status(200).json({ updated: 0 });
      return;
    }

    const dates = rows.map((r) => r.date);
    const priceMap = await fetchSpxPrices(dates);

    let updated = 0;
    for (const date of dates) {
      const prices = priceMap.get(date);
      if (prices != null) {
        await sql`
          UPDATE trace_predictions
          SET
            actual_close  = ${prices.close},
            current_price = ${prices.open},
            updated_at    = now()
          WHERE date = ${date}
        `;
        updated++;
      }
    }

    res
      .status(200)
      .json({ updated, attempted: dates.length, found: priceMap.size });
  } catch (err) {
    logger.error({ err }, 'trace/refresh-actuals failed');
    res.status(500).json({ error: 'Failed to refresh actuals' });
  }
}
