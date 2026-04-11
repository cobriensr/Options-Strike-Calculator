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

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import {
  cronGuard,
  uwFetch,
  withRetry,
  checkDataQuality,
} from '../_lib/api-helpers.js';
import { reportCronRun } from '../_lib/axiom.js';
import {
  getETTime,
  getETDayOfWeek,
  getETDateStr,
} from '../../src/utils/timezone.js';

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const force = req.query.force === 'true';
  const guard = cronGuard(req, res, {
    timeCheck: force ? () => true : isPreMarket,
  });
  if (!guard) return;
  const { apiKey, today: todayStr } = guard;

  const startTime = Date.now();

  try {
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

    const durationMs = Date.now() - startTime;
    await reportCronRun('fetch-economic-calendar', {
      status: 'ok',
      date: todayStr,
      eventsStored: todayEvents.length,
      events: todayEvents.map((e) => e.event),
      durationMs,
    });

    return res.status(200).json({
      job: 'fetch-economic-calendar',
      date: todayStr,
      eventsStored: todayEvents.length,
      events: todayEvents.map((e) => e.event),
      durationMs,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-economic-calendar');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-economic-calendar error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
