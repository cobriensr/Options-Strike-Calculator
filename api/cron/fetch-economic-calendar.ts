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
import logger from '../_lib/logger.js';
import {
  getETTime,
  getETDayOfWeek,
  getETDateStr,
} from '../../src/utils/timezone.js';

const UW_BASE = 'https://api.unusualwhales.com/api';

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

// ── Fetch helper ────────────────────────────────────────────

async function fetchCalendar(apiKey: string): Promise<CalendarEvent[]> {
  const res = await fetch(`${UW_BASE}/market/economic-calendar`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`UW calendar API ${res.status}: ${text.slice(0, 200)}`);
  }

  const body = await res.json();
  return body.data ?? [];
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }

  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const force = req.query.force === 'true';
  if (!force && !isPreMarket()) {
    return res.status(200).json({
      skipped: true,
      reason: 'Outside pre-market window',
    });
  }

  const apiKey = process.env.UW_API_KEY;
  if (!apiKey) {
    logger.error('UW_API_KEY not configured');
    return res.status(500).json({ error: 'UW_API_KEY not configured' });
  }

  const now = new Date();
  const todayStr = getETDateStr(now);

  try {
    const events = await fetchCalendar(apiKey);

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

    logger.info(
      {
        date: todayStr,
        eventsStored: todayEvents.length,
        events: todayEvents.map((e) => e.event),
      },
      'fetch-economic-calendar completed',
    );

    return res.status(200).json({
      date: todayStr,
      eventsStored: todayEvents.length,
      events: todayEvents.map((e) => e.event),
    });
  } catch (err) {
    logger.error({ err }, 'fetch-economic-calendar error');
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Fetch failed',
    });
  }
}
