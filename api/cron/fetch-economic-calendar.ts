/**
 * GET /api/cron/fetch-economic-calendar
 *
 * Fetches the economic calendar from Unusual Whales API and stores
 * today's events in the economic_events table.
 *
 * Runs once daily before market open (9:00-9:30 AM ET on weekdays).
 * Categorizes each event by type (FOMC, CPI, PCE, JOBS, GDP, PMI, etc.)
 *
 * Total API calls per invocation: 1
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import { getDb } from '../_lib/db.js';
import { uwFetch, withRetry, checkDataQuality } from '../_lib/api-helpers.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import {
  getETTime,
  getETDayOfWeek,
  getETDateStr,
} from '../../src/utils/timezone.js';

// DST-safe double-fire schedule: `25 13,14 * * 1-5` runs at both
// 13:25 UTC and 14:25 UTC. One fire always lands in the 9:00–9:30 ET
// pre-market window; the other misfires and gets rejected by the
// isPreMarket() gate. This way we don't shift the cron across DST.

// ── Types ───────────────────────────────────────────────────

interface CalendarEvent {
  event: string;
  forecast: string;
  prev: string;
  reported_period: string;
  time: string;
  type: string;
}

// ── Pre-market window check ─────────────────────────────────

function isPreMarket(): boolean {
  const now = new Date();
  const day = getETDayOfWeek(now);
  if (day === 0 || day === 6) return false;

  const { hour, minute } = getETTime(now);
  const totalMin = hour * 60 + minute;
  // 9:00 AM = 540, 9:30 AM = 570
  return totalMin >= 540 && totalMin <= 570;
}

// ── Event type categorization ───────────────────────────────

function categorizeEvent(eventName: string): string {
  const name = eventName;
  if (/FOMC|Federal Reserve|Fed/i.test(name)) return 'FOMC';
  if (/CPI|Consumer Price/i.test(name)) return 'CPI';
  if (/PCE/i.test(name)) return 'PCE';
  if (/Nonfarm|Employment|Jobs/i.test(name)) return 'JOBS';
  if (/GDP/i.test(name)) return 'GDP';
  if (/PMI/i.test(name)) return 'PMI';
  if (/Retail/i.test(name)) return 'RETAIL';
  if (/sentiment/i.test(name)) return 'SENTIMENT';
  return 'OTHER';
}

// ── Handler ─────────────────────────────────────────────────

export default withCronInstrumentation(
  'fetch-economic-calendar',
  async (ctx): Promise<CronResult> => {
    const { apiKey, today: todayStr, logger } = ctx;

    const events = await withRetry(() =>
      uwFetch<CalendarEvent>(apiKey, '/market/economic-calendar'),
    );

    // Filter to today's events only
    const todayEvents = events.filter((e) => {
      const eventDate = getETDateStr(new Date(e.time));
      return eventDate === todayStr;
    });

    const sql = getDb();

    for (const e of todayEvents) {
      const eventType = categorizeEvent(e.event);
      await sql`
        INSERT INTO economic_events (date, event_name, event_time, event_type, forecast, previous, reported_period)
        VALUES (${todayStr}, ${e.event}, ${e.time}, ${eventType}, ${e.forecast}, ${e.prev}, ${e.reported_period})
        ON CONFLICT (date, event_name, event_time) DO NOTHING
      `;
    }

    // Data quality check: alert if API returned events but all key fields are null
    if (todayEvents.length > 0) {
      const qcRows = await sql`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (
                 WHERE event_name IS NOT NULL AND event_name != ''
               ) AS has_name
        FROM economic_events
        WHERE date = ${todayStr}
      `;
      const { total, has_name } = qcRows[0]!;
      await checkDataQuality({
        job: 'fetch-economic-calendar',
        table: 'economic_events',
        date: todayStr,
        total: Number(total),
        nonzero: Number(has_name),
        minRows: 0,
      });
    }

    logger.info(
      {
        date: todayStr,
        eventsStored: todayEvents.length,
        events: todayEvents.map((e) => e.event),
      },
      'fetch-economic-calendar completed',
    );

    return {
      status: 'success',
      metadata: {
        date: todayStr,
        eventsStored: todayEvents.length,
        events: todayEvents.map((e) => e.event),
      },
    };
  },
  {
    // The static market-hours check from cronGuard would reject 9:00–9:30 ET
    // (pre-market). Disable it; the dynamicTimeCheck below owns the gate.
    marketHours: false,
    // ?force=true bypasses the pre-market window for one-shot manual
    // runs (e.g. backfilling after a failed schedule fire). Without
    // force, only the 9:00–9:30 ET pre-market window passes.
    dynamicTimeCheck: (req) => {
      const force = req.query?.force === 'true';
      if (force) return { run: true, reason: 'force=true' };
      return {
        run: isPreMarket(),
        reason: 'Outside time window',
      };
    },
  },
);
