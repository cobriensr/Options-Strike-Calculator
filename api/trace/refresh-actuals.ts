import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';

interface YahooChartResult {
  timestamp: number[];
  indicators: {
    quote: Array<{ open: (number | null)[]; close: (number | null)[] }>;
  };
}

interface YahooChartResponse {
  chart: {
    result?: YahooChartResult[];
    error?: { message: string };
  };
}

interface DayPrices {
  open: number;
  close: number;
}

async function fetchSpxPrices(
  dates: string[],
): Promise<Map<string, DayPrices>> {
  const timestamps = dates.map(
    (d) => new Date(`${d}T12:00:00Z`).getTime() / 1000,
  );
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
  const quote = result.indicators.quote[0];
  const opens = quote?.open ?? [];
  const closes = quote?.close ?? [];
  const { timestamp } = result;
  const priceMap = new Map<string, DayPrices>();

  for (let i = 0; i < timestamp.length; i++) {
    const open = opens[i];
    const close = closes[i];
    const ts = timestamp[i];
    if (open != null && close != null && ts != null) {
      const dateStr = new Date(ts * 1000).toISOString().slice(0, 10);
      priceMap.set(dateStr, {
        open: Math.round(open * 100) / 100,
        close: Math.round(close * 100) / 100,
      });
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

    res.status(200).json({ updated });
  } catch (err) {
    logger.error({ err }, 'trace/refresh-actuals failed');
    res.status(500).json({ error: 'Failed to refresh actuals' });
  }
}
