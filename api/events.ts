/**
 * GET /api/events
 *
 * Returns upcoming economic events from the FRED API (St. Louis Fed).
 * Public endpoint — no owner gate. Events are public government data.
 *
 * Fetches release dates for CPI, NFP, GDP, FOMC, PCE, PPI, Retail Sales,
 * and JOLTS. Results are cached in Upstash Redis for 24 hours.
 *
 * FOMC dates are not in FRED (they're policy meetings, not data releases),
 * so they're sourced from the static eventCalendar.ts and merged in.
 *
 * Query params:
 *   ?days=30  — how many days ahead to return (default 30, max 90)
 *
 * Environment variables:
 *   FRED_API_KEY — Free API key from https://fred.stlouisfed.org/docs/api/api_key.html
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { redis } from './_lib/schwab.js';

// ============================================================
// FRED RELEASE IDS → EVENT MAPPING
// ============================================================

interface FredReleaseConfig {
  readonly id: number;
  readonly event: string;
  readonly description: string;
  readonly time: string; // Typical release time ET
  readonly severity: 'high' | 'medium';
}

/**
 * FRED release IDs we care about for 0DTE trading.
 * IDs from https://fred.stlouisfed.org/releases
 */
const TRACKED_RELEASES: readonly FredReleaseConfig[] = [
  {
    id: 10,
    event: 'CPI',
    description: 'Consumer Price Index',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    id: 50,
    event: 'NFP',
    description: 'Employment Situation (Nonfarm Payrolls)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    id: 53,
    event: 'GDP',
    description: 'Gross Domestic Product',
    time: '8:30 AM',
    severity: 'medium',
  },
  {
    id: 54,
    event: 'PCE',
    description: 'Personal Income and Outlays (PCE Inflation)',
    time: '8:30 AM',
    severity: 'high',
  },
  {
    id: 51,
    event: 'PPI',
    description: 'Producer Price Index',
    time: '8:30 AM',
    severity: 'medium',
  },
  {
    id: 9,
    event: 'Retail Sales',
    description: 'Advance Monthly Sales for Retail and Food Services',
    time: '8:30 AM',
    severity: 'medium',
  },
  {
    id: 110,
    event: 'JOLTS',
    description: 'Job Openings and Labor Turnover Survey',
    time: '10:00 AM',
    severity: 'medium',
  },
] as const;

/**
 * Static FOMC dates — not available via FRED API.
 * These are policy meetings, not data releases.
 * Source: https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
 */
const FOMC_DATES_2025 = [
  '2025-01-29',
  '2025-03-19',
  '2025-05-07',
  '2025-06-18',
  '2025-07-30',
  '2025-09-17',
  '2025-10-29',
  '2025-12-10',
] as const;

const FOMC_DATES_2026 = [
  '2026-01-28',
  '2026-03-18',
  '2026-05-06',
  '2026-06-17',
  '2026-07-29',
  '2026-09-16',
  '2026-10-28',
  '2026-12-09',
] as const;

const SEP_DATES = new Set([
  '2025-03-19',
  '2025-06-18',
  '2025-09-17',
  '2025-12-10',
  '2026-03-18',
  '2026-06-17',
  '2026-09-16',
  '2026-12-09',
]);

const ALL_FOMC = [...FOMC_DATES_2025, ...FOMC_DATES_2026];

// ============================================================
// TYPES
// ============================================================

interface FredReleaseDateEntry {
  release_id: number;
  release_name: string;
  date: string;
}

interface FredReleaseDatesResponse {
  release_dates: FredReleaseDateEntry[];
}

interface EventItem {
  date: string;
  event: string;
  description: string;
  time: string;
  severity: 'high' | 'medium';
  source: 'fred' | 'static';
}

// ============================================================
// FRED API FETCH
// ============================================================

const FRED_BASE = 'https://api.stlouisfed.org/fred';
const REDIS_KEY = 'fred:events';
const CACHE_TTL_SEC = 7 * 24 * 60 * 60; // 7 days (key is date-scoped, so stale keys auto-expire)

/**
 * Fetch release dates from FRED for a specific release ID.
 * Uses fred/release/dates (singular) to get dates for one release at a time.
 */
async function fetchReleaseDates(
  releaseId: number,
  apiKey: string,
  startDate: string,
  endDate: string,
): Promise<FredReleaseDateEntry[]> {
  const params = new URLSearchParams({
    release_id: String(releaseId),
    api_key: apiKey,
    file_type: 'json',
    include_release_dates_with_no_data: 'true',
    sort_order: 'asc',
  });

  const url = `${FRED_BASE}/release/dates?${params.toString()}`;
  const res = await fetch(url);

  if (!res.ok) {
    console.error(`FRED API error for release ${releaseId}: ${res.status}`);
    return [];
  }

  const data: FredReleaseDatesResponse = await res.json();

  // Filter to our date range (FRED may return a wider range)
  return (data.release_dates || []).filter(
    (r) => r.date >= startDate && r.date <= endDate,
  );
}

/**
 * Fetch all tracked events from FRED and merge with static FOMC dates.
 */
async function fetchAllEvents(
  apiKey: string,
  startDate: string,
  endDate: string,
): Promise<EventItem[]> {
  const releaseMap = new Map<number, FredReleaseConfig>();
  for (const r of TRACKED_RELEASES) releaseMap.set(r.id, r);

  // Fetch all release dates in parallel
  const results = await Promise.all(
    TRACKED_RELEASES.map((r) =>
      fetchReleaseDates(r.id, apiKey, startDate, endDate),
    ),
  );

  const events: EventItem[] = [];

  // Map FRED results to events
  for (const entries of results) {
    for (const entry of entries) {
      const config = releaseMap.get(entry.release_id);
      if (!config) continue;

      events.push({
        date: entry.date,
        event: config.event,
        description: config.description,
        time: config.time,
        severity: config.severity,
        source: 'fred',
      });
    }
  }

  // Add static FOMC dates within range
  for (const fomcDate of ALL_FOMC) {
    if (fomcDate >= startDate && fomcDate <= endDate) {
      const hasSEP = SEP_DATES.has(fomcDate);
      events.push({
        date: fomcDate,
        event: hasSEP ? 'FOMC + SEP' : 'FOMC',
        description: hasSEP
          ? 'Fed rate decision + Summary of Economic Projections (dot plot)'
          : 'Federal Reserve interest rate decision',
        time: '2:00 PM',
        severity: 'high',
        source: 'static',
      });
    }
  }

  // Sort by date, then severity (high first)
  events.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    if (a.severity !== b.severity) return a.severity === 'high' ? -1 : 1;
    return 0;
  });

  return events;
}

// ============================================================
// HANDLER
// ============================================================

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    return res
      .status(500)
      .json({ error: 'FRED_API_KEY environment variable must be set' });
  }

  // Parse days parameter (default 30, max 90)
  const daysParam = Number(req.query?.days) || 30;
  const days = Math.min(Math.max(daysParam, 1), 90);

  // Date range: today → today + days
  const now = new Date();
  const startDate = now.toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  });
  const endDate = new Date(
    now.getTime() + days * 24 * 60 * 60 * 1000,
  ).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  // Try Redis cache first
  const cacheKey = `${REDIS_KEY}:${startDate}:${days}`;
  try {
    const cached = await redis.get<EventItem[]>(cacheKey);
    if (cached) {
      res.setHeader(
        'Cache-Control',
        's-maxage=43200, stale-while-revalidate=3600',
      );
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json({
        events: cached,
        startDate,
        endDate,
        cached: true,
        asOf: new Date().toISOString(),
      });
    }
  } catch {
    // Redis unavailable — fetch fresh
  }

  // Fetch from FRED
  const events = await fetchAllEvents(apiKey, startDate, endDate);

  // Cache in Redis for 24h
  try {
    await redis.set(cacheKey, events, { ex: CACHE_TTL_SEC });
  } catch (err) {
    console.error('Failed to cache events in Redis:', err);
  }

  // Edge cache: 1 hour (events change at most daily)
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=1800');
  res.setHeader('X-Cache', 'MISS');

  res.status(200).json({
    events,
    startDate,
    endDate,
    cached: false,
    asOf: new Date().toISOString(),
  });
}
