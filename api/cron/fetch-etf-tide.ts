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
import { Sentry, metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import {
  cronGuard,
  uwFetch,
  roundTo5Min,
  withRetry,
  checkDataQuality,
} from '../_lib/api-helpers.js';

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
  // Omit ?date= for current-day fetches — the UW API returns zeros
  // when ?date= is the current trading day. Without the param, it
  // returns the live cumulative intraday series. The backfill script
  // passes ?date= for historical dates where it works correctly.
  return uwFetch<EtfTideRow>(apiKey, `/market/${ticker}/etf-tide`);
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
    const rounded = roundTo5Min(new Date(row.timestamp));
    const key = rounded.toISOString();

    const ncpRaw = Number.parseFloat(row.net_call_premium);
    const nppRaw = Number.parseFloat(row.net_put_premium);
    if (Number.isNaN(ncpRaw) || Number.isNaN(nppRaw)) {
      metrics.increment('fetch_etf_tide.invalid_candle');
    }

    sampled.set(key, {
      timestamp: key,
      ncp: ncpRaw || 0,
      npp: nppRaw || 0,
      netVolume: row.net_volume || 0,
    });
  }

  return Array.from(sampled.values()).sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
}

// ── Store helper ────────────────────────────────────────────

async function storeAllCandles(
  candles: Array<{
    timestamp: string;
    ncp: number;
    npp: number;
    netVolume: number;
  }>,
  source: string,
  date: string,
): Promise<{ stored: number; skipped: number }> {
  if (candles.length === 0) return { stored: 0, skipped: 0 };

  const sql = getDb();
  let stored = 0;
  let skipped = 0;

  for (const candle of candles) {
    const result = await sql`
      INSERT INTO flow_data (date, timestamp, source, ncp, npp, net_volume)
      VALUES (${date}, ${candle.timestamp}, ${source}, ${candle.ncp}, ${candle.npp}, ${candle.netVolume})
      ON CONFLICT (date, timestamp, source) DO NOTHING
      RETURNING id
    `;
    if (result.length > 0) stored++;
    else skipped++;
  }

  return { stored, skipped };
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res);
  if (!guard) return;
  const { apiKey, today } = guard;

  const startTime = Date.now();

  try {
    const results: Record<
      string,
      { stored: number; skipped: number; candles: number }
    > = {};

    await Promise.all(
      TICKERS.map(async ({ ticker, source }) => {
        try {
          const rows = await withRetry(() => fetchEtfTide(apiKey, ticker));
          const candles = sampleTo5Min(rows);
          const result = await storeAllCandles(candles, source, today);
          results[source] = { ...result, candles: candles.length };
        } catch (err) {
          logger.warn({ err, ticker, source }, 'Failed to fetch ETF Tide');
          metrics.increment('fetch_etf_tide.fetch_error');
          Sentry.captureException(err);
          results[source] = { stored: 0, skipped: 0, candles: 0 };
        }
      }),
    );

    // Data quality check: alert if all values are zero
    for (const [source, r] of Object.entries(results)) {
      if (r.candles > 10 && r.stored === r.candles) {
        // All candles were new (no duplicates) — check the raw data
        // for all-zero values which indicate an upstream data issue
        const rows = await getDb()`
          SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE ncp::numeric != 0 OR npp::numeric != 0) AS nonzero
          FROM flow_data
          WHERE date = ${today} AND source = ${source}
        `;
        const { total, nonzero } = rows[0]!;
        await checkDataQuality({
          job: 'fetch-etf-tide',
          table: 'flow_data',
          date: today,
          sourceFilter: source,
          total: Number(total),
          nonzero: Number(nonzero),
        });
      }
    }

    logger.info({ results }, 'fetch-etf-tide completed');

    return res.status(200).json({
      job: 'fetch-etf-tide',
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
