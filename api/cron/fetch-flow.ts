/**
 * GET /api/cron/fetch-flow
 *
 * Fetches Market Tide data from Unusual Whales API and stores in Postgres.
 * Designed to run every 5 minutes during market hours via Vercel Cron.
 *
 * Fetches both all-in and OTM-only Market Tide data in a single invocation.
 * Each call stores the latest 5-minute candle (avoids duplicates via UPSERT).
 *
 * Environment: UW_API_KEY, CRON_SECRET (for Vercel cron auth)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { TIMEOUTS } from '../_lib/constants.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { isMarketHours, withRetry } from '../_lib/api-helpers.js';

const UW_BASE = 'https://api.unusualwhales.com/api';

// ── Fetch helper ────────────────────────────────────────────

interface MarketTideRow {
  date: string;
  net_call_premium: string;
  net_put_premium: string;
  net_volume: number;
  timestamp: string;
}

async function fetchMarketTide(
  apiKey: string,
  otmOnly: boolean,
): Promise<MarketTideRow[]> {
  const params = new URLSearchParams({ interval_5m: 'true' });
  if (otmOnly) params.set('otm_only', 'true');

  const res = await fetch(`${UW_BASE}/market/market-tide?${params}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(TIMEOUTS.UW_API),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`UW API ${res.status}: ${text.slice(0, 200)}`);
  }

  const body = await res.json();
  return body.data ?? [];
}

// ── Store helper ────────────────────────────────────────────

async function storeLatestCandle(
  rows: MarketTideRow[],
  source: string,
): Promise<{ stored: boolean; timestamp?: string }> {
  if (rows.length === 0) return { stored: false };

  // Get the most recent candle
  const latest = rows[rows.length - 1]!;
  const sql = getDb();

  await sql`
    INSERT INTO flow_data (date, timestamp, source, ncp, npp, net_volume)
    VALUES (
      ${latest.date},
      ${latest.timestamp},
      ${source},
      ${latest.net_call_premium},
      ${latest.net_put_premium},
      ${latest.net_volume}
    )
    ON CONFLICT (date, timestamp, source) DO NOTHING
  `;

  return { stored: true, timestamp: latest.timestamp };
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Only allow GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }

  // Verify cron secret (Vercel sends this header for cron invocations)
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Skip outside market hours
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
    // Fetch both all-in and OTM Market Tide in parallel; partial failures are tolerated
    const [allInFetch, otmFetch] = await Promise.allSettled([
      withRetry(() => fetchMarketTide(apiKey, false)),
      withRetry(() => fetchMarketTide(apiKey, true)),
    ]);

    if (allInFetch.status === 'rejected') {
      logger.warn(
        { err: allInFetch.reason },
        'fetch-flow: all-in fetch failed',
      );
    }
    if (otmFetch.status === 'rejected') {
      logger.warn({ err: otmFetch.reason }, 'fetch-flow: OTM fetch failed');
    }

    // Store whichever fetches succeeded
    const allInRows =
      allInFetch.status === 'fulfilled' ? allInFetch.value : null;
    const otmRows = otmFetch.status === 'fulfilled' ? otmFetch.value : null;

    const [allInStore, otmStore] = await Promise.allSettled([
      allInRows !== null
        ? withRetry(() => storeLatestCandle(allInRows, 'market_tide'))
        : Promise.reject(new Error('fetch skipped')),
      otmRows !== null
        ? withRetry(() => storeLatestCandle(otmRows, 'market_tide_otm'))
        : Promise.reject(new Error('fetch skipped')),
    ]);

    if (allInStore.status === 'rejected') {
      logger.warn(
        { err: allInStore.reason },
        'fetch-flow: all-in store failed',
      );
    }
    if (otmStore.status === 'rejected') {
      logger.warn({ err: otmStore.reason }, 'fetch-flow: OTM store failed');
    }

    const allInResult =
      allInStore.status === 'fulfilled' ? allInStore.value : null;
    const otmResult = otmStore.status === 'fulfilled' ? otmStore.value : null;
    const anyStored = allInResult !== null || otmResult !== null;
    const partial =
      allInFetch.status === 'rejected' ||
      allInStore.status === 'rejected' ||
      otmFetch.status === 'rejected' ||
      otmStore.status === 'rejected';

    // Data quality check: alert if all values are zero
    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/New_York',
    });
    for (const source of ['market_tide', 'market_tide_otm'] as const) {
      const rows = await getDb()`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE ncp::numeric != 0 OR npp::numeric != 0) AS nonzero
        FROM flow_data
        WHERE date = ${today} AND source = ${source}
      `;
      const { total, nonzero } = rows[0]!;
      if (Number(total) > 10 && Number(nonzero) === 0) {
        Sentry.setTag('cron.job', 'fetch-flow');
        Sentry.captureMessage(
          `Data quality alert: ${source} has ${total} rows but ALL values are zero for ${today}`,
          'warning',
        );
        logger.warn(
          { source, total, date: today },
          'Market Tide data quality: all values zero',
        );
      }
    }

    logger.info(
      {
        allIn: allInResult,
        otm: otmResult,
        allInRows: allInRows?.length ?? 0,
        otmRows: otmRows?.length ?? 0,
        partial,
      },
      'fetch-flow completed',
    );

    if (!anyStored) {
      return res.status(500).json({ error: 'All sources failed' });
    }

    return res.status(200).json({
      stored: anyStored,
      partial,
      market_tide: allInResult,
      market_tide_otm: otmResult,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-flow');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-flow error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
