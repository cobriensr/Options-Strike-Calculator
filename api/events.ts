/**
 * GET /api/events
 *
 * Returns upcoming market events from multiple sources:
 *   - FRED API: CPI, NFP, GDP, PCE, PPI, Retail Sales, JOLTS
 *   - Static: FOMC dates, half-day/early close dates
 *   - Finnhub API: Mega-cap earnings (AAPL, MSFT, NVDA, AMZN, GOOG, META, TSLA)
 *
 * Public endpoint — no owner gate. All data is publicly available.
 * Results cached in Upstash Redis for 7 days (key is date-scoped).
 *
 * Query params:
 *   ?days=30  — how many days ahead to return (default 30, max 90)
 *
 * Environment variables:
 *   FRED_API_KEY    — Free key from https://fred.stlouisfed.org/docs/api/api_key.html
 *   FINNHUB_API_KEY — Free key from https://finnhub.io/register (optional, earnings only)
 */

import { Sentry, metrics } from './_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { checkBot } from './_lib/api-helpers.js';
import { redis } from './_lib/schwab.js';
import logger from './_lib/logger.js';

// ============================================================
// FRED RELEASE IDS → EVENT MAPPING
// ============================================================

interface FredReleaseConfig {
  readonly id: number;
  readonly event: string;
  readonly description: string;
  readonly time: string;
  readonly severity: 'high' | 'medium';
}

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

// ============================================================
// STATIC FOMC DATES
// ============================================================

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
// STATIC HALF-DAY / EARLY CLOSE DATES
// ============================================================

/**
 * NYSE early close days — market closes at 1:00 PM ET instead of 4:00 PM.
 * This reduces time-to-expiry by 3 hours, significantly impacting 0DTE pricing.
 *
 * Recurring pattern:
 *   - Day before Independence Day (July 3, unless July 4 is Sat/Sun)
 *   - Black Friday (day after Thanksgiving)
 *   - Christmas Eve (Dec 24, unless it falls on weekend)
 *
 * Also includes full market closures for Good Friday (no 0DTE possible).
 *
 * Sources: https://www.nyse.com/markets/hours-calendars
 */
interface HalfDayEntry {
  readonly date: string;
  readonly type: 'early_close' | 'closed';
  readonly closeTime?: string;
  readonly reason: string;
}

const HALF_DAYS_2025: readonly HalfDayEntry[] = [
  { date: '2025-04-18', type: 'closed', reason: 'Good Friday' },
  {
    date: '2025-07-03',
    type: 'early_close',
    closeTime: '1:00 PM',
    reason: 'Independence Day Eve',
  },
  {
    date: '2025-11-28',
    type: 'early_close',
    closeTime: '1:00 PM',
    reason: 'Black Friday',
  },
  {
    date: '2025-12-24',
    type: 'early_close',
    closeTime: '1:00 PM',
    reason: 'Christmas Eve',
  },
] as const;

const HALF_DAYS_2026: readonly HalfDayEntry[] = [
  { date: '2026-04-03', type: 'closed', reason: 'Good Friday' },
  {
    date: '2026-07-03',
    type: 'early_close',
    closeTime: '1:00 PM',
    reason: 'Independence Day Eve',
  },
  {
    date: '2026-11-27',
    type: 'early_close',
    closeTime: '1:00 PM',
    reason: 'Black Friday',
  },
  {
    date: '2026-12-24',
    type: 'early_close',
    closeTime: '1:00 PM',
    reason: 'Christmas Eve',
  },
] as const;

const ALL_HALF_DAYS = [...HALF_DAYS_2025, ...HALF_DAYS_2026];

// ============================================================
// MEGA-CAP EARNINGS (FINNHUB)
// ============================================================

/**
 * The "Magnificent 7" — each represents 3–8% of SPX.
 * When one reports earnings (even after hours), the next morning's
 * SPX open can gap significantly.
 */
const MEGA_CAP_SYMBOLS = new Set([
  'AAPL',
  'MSFT',
  'NVDA',
  'AMZN',
  'GOOG',
  'META',
  'TSLA',
]);

const FINNHUB_BASE = 'https://finnhub.io/api/v1';

interface FinnhubEarningsEntry {
  date: string;
  epsActual: number | null;
  epsEstimate: number | null;
  hour: string; // 'bmo' (before open), 'amc' (after close), 'dmh' (during)
  quarter: number;
  revenueActual: number | null;
  revenueEstimate: number | null;
  symbol: string;
  year: number;
}

interface FinnhubEarningsResponse {
  earningsCalendar: FinnhubEarningsEntry[];
}

async function fetchMegaCapEarnings(
  apiKey: string,
  startDate: string,
  endDate: string,
): Promise<EventItem[]> {
  const events: EventItem[] = [];

  try {
    const params = new URLSearchParams({
      from: startDate,
      to: endDate,
      token: apiKey,
    });

    const url = `${FINNHUB_BASE}/calendar/earnings?${params.toString()}`;
    const res = await fetch(url);

    if (!res.ok) {
      logger.error({ status: res.status }, 'Finnhub earnings API error');
      return [];
    }

    const data: FinnhubEarningsResponse = await res.json();

    for (const entry of data.earningsCalendar || []) {
      if (!MEGA_CAP_SYMBOLS.has(entry.symbol)) continue;

      const timeLabel =
        entry.hour === 'bmo'
          ? 'Before Open'
          : entry.hour === 'amc'
            ? 'After Close'
            : entry.hour === 'dmh'
              ? 'During Hours'
              : '';

      events.push({
        date: entry.date,
        event: `${entry.symbol} Earnings`,
        description: `${entry.symbol} Q${entry.quarter} ${entry.year} earnings${timeLabel ? ' (' + timeLabel + ')' : ''}`,
        time: timeLabel || 'TBD',
        severity: 'high',
        source: 'finnhub',
      });
    }
  } catch (err) {
    logger.error({ err }, 'Finnhub earnings fetch failed');
  }

  return events;
}

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
  source: 'fred' | 'static' | 'finnhub';
}

// ============================================================
// FRED API FETCH
// ============================================================

const FRED_BASE = 'https://api.stlouisfed.org/fred';
const REDIS_KEY = 'events:v2';
const CACHE_TTL_SEC = 7 * 24 * 60 * 60; // 7 days (key is date-scoped)

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
    logger.error({ releaseId, status: res.status }, 'FRED API error');
    return [];
  }

  const data: FredReleaseDatesResponse = await res.json();

  return (data.release_dates || []).filter(
    (r) => r.date >= startDate && r.date <= endDate,
  );
}

// ============================================================
// MAIN FETCH
// ============================================================

async function fetchAllEvents(
  fredKey: string,
  finnhubKey: string | undefined,
  startDate: string,
  endDate: string,
): Promise<EventItem[]> {
  const releaseMap = new Map<number, FredReleaseConfig>();
  for (const r of TRACKED_RELEASES) releaseMap.set(r.id, r);

  // Fetch FRED releases + Finnhub earnings in parallel
  const fredPromises = TRACKED_RELEASES.map((r) =>
    fetchReleaseDates(r.id, fredKey, startDate, endDate),
  );
  const earningsPromise = finnhubKey
    ? fetchMegaCapEarnings(finnhubKey, startDate, endDate)
    : Promise.resolve([] as EventItem[]);

  const [fredResults, earningsEvents] = await Promise.all([
    Promise.all(fredPromises),
    earningsPromise,
  ]);

  const events: EventItem[] = [];

  // Map FRED results to events
  for (const entries of fredResults) {
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

  // Add half-day / early close dates within range
  for (const hd of ALL_HALF_DAYS) {
    if (hd.date >= startDate && hd.date <= endDate) {
      if (hd.type === 'closed') {
        events.push({
          date: hd.date,
          event: 'CLOSED',
          description: `Market closed \u2014 ${hd.reason}`,
          time: 'All Day',
          severity: 'high',
          source: 'static',
        });
      } else {
        events.push({
          date: hd.date,
          event: 'EARLY CLOSE',
          description: `Market closes at ${hd.closeTime} ET \u2014 ${hd.reason}. Time-to-expiry uses ${hd.closeTime} instead of 4:00 PM.`,
          time: hd.closeTime!,
          severity: 'high',
          source: 'static',
        });
      }
    }
  }

  // Add mega-cap earnings
  events.push(...earningsEvents);

  // Sort by date, then severity (high first), then event name
  events.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    if (a.severity !== b.severity) return a.severity === 'high' ? -1 : 1;
    return a.event.localeCompare(b.event);
  });

  return events;
}

// ============================================================
// HANDLER
// ============================================================

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/events');
    const done = metrics.request('/api/events');
    try {
      const botCheck = await checkBot(req);
      if (botCheck.isBot) {
        done({ status: 403 });
        return res.status(403).json({ error: 'Access denied' });
      }

      const fredKey = process.env.FRED_API_KEY;
      if (!fredKey) {
        done({ status: 500 });
        return res
          .status(500)
          .json({ error: 'FRED_API_KEY environment variable must be set' });
      }
      const finnhubKey = process.env.FINNHUB_API_KEY; // optional — earnings only

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
          metrics.cacheResult('/api/events', true);
          res.setHeader(
            'Cache-Control',
            's-maxage=43200, stale-while-revalidate=3600',
          );
          res.setHeader('X-Cache', 'HIT');
          done({ status: 200 });
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

      // Fetch from all sources
      const events = await fetchAllEvents(
        fredKey,
        finnhubKey,
        startDate,
        endDate,
      );

      // Cache in Redis for 7 days (key is date-scoped, stale keys auto-expire)
      try {
        await redis.set(cacheKey, events, { ex: CACHE_TTL_SEC });
      } catch (err) {
        logger.error({ err }, 'Failed to cache events in Redis');
      }

      // Edge cache: 12 hours
      res.setHeader(
        'Cache-Control',
        's-maxage=43200, stale-while-revalidate=3600',
      );
      res.setHeader('X-Cache', 'MISS');

      done({ status: 200 });
      res.status(200).json({
        events,
        startDate,
        endDate,
        cached: false,
        asOf: new Date().toISOString(),
      });
    } catch (error) {
      done({ status: 500, error: 'unhandled' });
      Sentry.captureException(error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
