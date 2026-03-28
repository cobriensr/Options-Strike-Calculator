/**
 * GET /api/cron/fetch-etf-tide
 *
 * Fetches ETF Tide data from Unusual Whales API for SPY and QQQ.
 * ETF Tide measures options flow on the individual holdings of an ETF,
 * not on the ETF itself — a more granular view of directional conviction.
 *
 * Same response format as Market Tide (cumulative NCP/NPP/volume).
 * Stores in flow_data table with sources: 'spy_etf_tide', 'qqq_etf_tide'
 *
 * Total API calls per invocation: 2
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

const TICKERS: Array<{ ticker: string; source: string }> = [
  { ticker: 'SPY', source: 'spy_etf_tide' },
  { ticker: 'QQQ', source: 'qqq_etf_tide' },
];

// ── Types ───────────────────────────────────────────────────

interface EtfTideRow {
  net_call_premium: string;
  net_put_premium: string;
  net_volume: number;
  timestamp: string;
}

// ── Fetch helper ────────────────────────────────────────────

async function fetchEtfTide(
  apiKey: string,
  ticker: string,
): Promise<EtfTideRow[]> {
  const res = await fetch(`${UW_BASE}/market/${ticker}/etf-tide`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(TIMEOUTS.UW_API),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `UW API ${res.status} for ${ticker} ETF Tide: ${text.slice(0, 200)}`,
    );
  }

  const body = await res.json();
  return body.data ?? [];
}

// ── Sample to 5-min intervals ───────────────────────────────

function sampleTo5Min(
  rows: EtfTideRow[],
): Array<{ timestamp: string; ncp: number; npp: number; netVolume: number }> {
  if (rows.length === 0) return [];

  const sampled = new Map<
    string,
    { timestamp: string; ncp: number; npp: number; netVolume: number }
  >();

  for (const row of rows) {
    const dt = new Date(row.timestamp);
    const minutes = dt.getMinutes();
    const rounded = new Date(dt);
    rounded.setMinutes(minutes - (minutes % 5), 0, 0);
    const key = rounded.toISOString();

    sampled.set(key, {
      timestamp: key,
      ncp: Number.parseFloat(row.net_call_premium) || 0,
      npp: Number.parseFloat(row.net_put_premium) || 0,
      netVolume: row.net_volume || 0,
    });
  }

  return Array.from(sampled.values()).sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
}

// ── Store helper ────────────────────────────────────────────

async function storeLatestCandle(
  candles: Array<{
    timestamp: string;
    ncp: number;
    npp: number;
    netVolume: number;
  }>,
  source: string,
  date: string,
): Promise<{ stored: boolean; timestamp?: string }> {
  if (candles.length === 0) return { stored: false };

  const latest = candles.at(-1)!;
  const sql = getDb();

  await sql`
    INSERT INTO flow_data (date, timestamp, source, ncp, npp, net_volume)
    VALUES (${date}, ${latest.timestamp}, ${source}, ${latest.ncp}, ${latest.npp}, ${latest.netVolume})
    ON CONFLICT (date, timestamp, source) DO NOTHING
  `;

  return { stored: true, timestamp: latest.timestamp };
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

  // Get today's date in ET
  const today = new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  });

  try {
    const results: Record<string, { stored: boolean; timestamp?: string }> = {};

    const fetches = await Promise.all(
      TICKERS.map(async ({ ticker, source }) => {
        try {
          const rows = await withRetry(() => fetchEtfTide(apiKey, ticker));
          const candles = sampleTo5Min(rows);
          const result = await withRetry(() =>
            storeLatestCandle(candles, source, today),
          );
          return { source, result, candleCount: candles.length };
        } catch (err) {
          logger.warn({ err, ticker, source }, 'Failed to fetch ETF Tide');
          return { source, result: { stored: false }, candleCount: 0 };
        }
      }),
    );

    for (const f of fetches) {
      results[f.source] = f.result;
    }

    logger.info({ results }, 'fetch-etf-tide completed');

    return res.status(200).json({
      job: 'fetch-etf-tide',
      stored: true,
      results,
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-etf-tide');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-etf-tide error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
