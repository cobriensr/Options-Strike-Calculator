import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';

interface YahooChartResult {
  timestamp: number[];
  indicators: { quote: Array<{ close: (number | null)[] }> };
}

interface YahooChartResponse {
  chart: {
    result?: YahooChartResult[];
    error?: { message: string };
  };
}

async function fetchSpxCloses(dates: string[]): Promise<Map<string, number>> {
  const timestamps = dates.map((d) => new Date(`${d}T12:00:00Z`).getTime() / 1000);
  const period1 = Math.floor(Math.min(...timestamps) - 5 * 86400);
  const period2 = Math.floor(Math.max(...timestamps) + 2 * 86400);

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5ESPX?interval=1d&period1=${period1}&period2=${period2}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Yahoo Finance returned ${res.status}`);

  const data = (await res.json()) as YahooChartResponse;
  if (!data.chart.result?.[0]) {
    throw new Error(data.chart.error?.message ?? 'No data from Yahoo Finance');
  }

  const result = data.chart.result[0];
  const closes = result.indicators.quote[0]?.close ?? [];
  const { timestamp } = result;
  const priceMap = new Map<string, number>();

  for (let i = 0; i < timestamp.length; i++) {
    const close = closes[i];
    const ts = timestamp[i];
    if (close != null && ts != null) {
      // Yahoo timestamps are at close time (4 PM ET = ~21:00 UTC in winter)
      // UTC date always matches the trading date
      const dateStr = new Date(ts * 1000).toISOString().slice(0, 10);
      priceMap.set(dateStr, Math.round(close * 100) / 100);
    }
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
    const rows = (await sql`
      SELECT date::text FROM trace_predictions
      WHERE actual_close IS NULL
      ORDER BY date
    `) as { date: string }[];

    if (rows.length === 0) {
      res.status(200).json({ updated: 0 });
      return;
    }

    const dates = rows.map((r) => r.date);
    const priceMap = await fetchSpxCloses(dates);

    let updated = 0;
    for (const date of dates) {
      const close = priceMap.get(date);
      if (close != null) {
        await sql`
          UPDATE trace_predictions
          SET actual_close = ${close}, updated_at = now()
          WHERE date = ${date}
        `;
        updated++;
      }
    }

    res.status(200).json({ updated });
  } catch (err) {
    logger.error({ err }, 'trace/refresh-actuals failed');
    res.status(500).json({ error: 'Failed to refresh actuals' });
  }
}
