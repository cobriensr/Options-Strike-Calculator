import type { VercelRequest, VercelResponse } from '@vercel/node';
import { schwabFetch } from '../_lib/api-helpers.js';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';

interface DayPrices {
  open: number;
  close: number;
}

interface SchwabCandle {
  open: number;
  close: number;
  datetime: number; // epoch ms
}

interface SchwabPriceHistory {
  candles: SchwabCandle[];
  symbol: string;
  empty: boolean;
}

/**
 * Fetch SPX daily open/close prices from Schwab for the given dates.
 *
 * Uses the same schwabFetch helper used by /api/history so tokens are
 * refreshed automatically.  Daily frequency returns one candle per
 * trading day with the session open and close already set.
 */
async function fetchSpxPrices(
  dates: string[],
): Promise<Map<string, DayPrices>> {
  const sorted = [...dates].sort((a, b) => a.localeCompare(b));

  // Pad a few days around the requested range to catch the nearest
  // trading day on either end.
  const startDate = new Date(`${sorted[0]}T12:00:00Z`);
  startDate.setDate(startDate.getDate() - 5);
  const endDate = new Date(`${sorted.at(-1)!}T12:00:00Z`);
  endDate.setDate(endDate.getDate() + 2);

  const params = new URLSearchParams({
    symbol: '$SPX',
    periodType: 'year',
    frequencyType: 'daily',
    frequency: '1',
    startDate: String(startDate.getTime()),
    endDate: String(endDate.getTime()),
    needExtendedHoursData: 'false',
    needPreviousClose: 'false',
  });

  const result = await schwabFetch<SchwabPriceHistory>(
    `/pricehistory?${params.toString()}`,
  );

  if (!result.ok) {
    throw new Error(`Schwab priceHistory failed: ${result.error}`);
  }

  const priceMap = new Map<string, DayPrices>();

  for (const candle of result.data.candles) {
    // Convert epoch ms → YYYY-MM-DD in ET (Schwab daily candles use ET midnight)
    const d = new Date(candle.datetime);
    const dateStr = d.toLocaleDateString('en-CA', {
      timeZone: 'America/New_York',
    });
    priceMap.set(dateStr, {
      open: Math.round(candle.open * 100) / 100,
      close: Math.round(candle.close * 100) / 100,
    });
  }

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

    logger.info(
      { dates, found: priceMap.size, updated },
      'trace/refresh-actuals complete',
    );

    res
      .status(200)
      .json({ updated, attempted: dates.length, found: priceMap.size });
  } catch (err) {
    logger.error({ err }, 'trace/refresh-actuals failed');
    res.status(500).json({ error: 'Failed to refresh actuals' });
  }
}
