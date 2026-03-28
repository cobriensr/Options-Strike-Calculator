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
import logger from '../_lib/logger.js';

const UW_BASE = 'https://api.unusualwhales.com/api';

// ── Market hours check ──────────────────────────────────────

function isMarketHours(): boolean {
  const now = new Date();
  const et = new Date(
    now.toLocaleString('en-US', { timeZone: 'America/New_York' }),
  );
  const day = et.getDay();
  // Skip weekends
  if (day === 0 || day === 6) return false;

  const hour = et.getHours();
  const minute = et.getMinutes();
  const timeMinutes = hour * 60 + minute;

  // Market hours: 9:30 AM ET (570) to 4:00 PM ET (960)
  // Start fetching 5 min early (9:25) to catch the open, stop at 4:05 for settlement
  return timeMinutes >= 565 && timeMinutes <= 965;
}

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
      fetchMarketTide(apiKey, false),
      fetchMarketTide(apiKey, true),
    ]);

    if (allInFetch.status === 'rejected') {
      logger.warn({ err: allInFetch.reason }, 'fetch-flow: all-in fetch failed');
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
        ? storeLatestCandle(allInRows, 'market_tide')
        : Promise.reject(new Error('fetch skipped')),
      otmRows !== null
        ? storeLatestCandle(otmRows, 'market_tide_otm')
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
    const otmResult =
      otmStore.status === 'fulfilled' ? otmStore.value : null;
    const anyStored = allInResult !== null || otmResult !== null;
    const partial =
      (allInFetch.status === 'rejected' || allInStore.status === 'rejected') ||
      (otmFetch.status === 'rejected' || otmStore.status === 'rejected');

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
    logger.error({ err }, 'fetch-flow error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
