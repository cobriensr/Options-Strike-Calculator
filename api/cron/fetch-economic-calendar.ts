/**
 * GET /api/cron/fetch-economic-calendar
 *
 * Fetches the economic calendar from Unusual Whales API and stores
 * today's events in the economic_events table.
 *
 * Runs once daily before market open (9:00-9:30 AM ET on weekdays).
 * Classifies each event by name (FOMC, FED, CPI, PCE, JOBS, GDP, PMI, etc.)
 * with classifyEconomicEvent.
 *
 * Total API calls per invocation: 1
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import { bulkUpsert } from '../_lib/bulk-upsert.js';
import { classifyEconomicEvent } from '../_lib/economic-event-type.js';
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

// ── Handler ─────────────────────────────────────────────────

export default withCronInstrumentation(
  'fetch-economic-calendar',
  async (ctx): Promise<CronResult> => {
    const { apiKey, today: todayStr, logger } = ctx;

    const events = await withRetry(() =>
      uwFetch<CalendarEvent>(apiKey, '/market/economic-calendar'),
    );

    // Filter to today's events only. An event whose `time` doesn't parse is
    // skipped and counted: formatting an Invalid Date throws, and one bad row
    // must not fail the whole day's run.
    const todayEvents: CalendarEvent[] = [];
    let invalidTimeSkipped = 0;
    for (const e of events) {
      const eventAt = new Date(e.time);
      if (Number.isNaN(eventAt.getTime())) {
        invalidTimeSkipped++;
        logger.warn(
          { event: e.event, time: e.time },
          'fetch-economic-calendar: skipping event with unparseable time',
        );
        continue;
      }
      if (getETDateStr(eventAt) === todayStr) todayEvents.push(e);
    }

    const sql = getDb();

    // Collapse the per-row INSERT loop into one parameterized statement.
    // ON CONFLICT DO NOTHING is preserved via conflictUpdateColumns: [].
    const rows = todayEvents.map((e) => ({
      date: todayStr,
      event_name: e.event,
      event_time: e.time,
      event_type: classifyEconomicEvent(e.event),
      forecast: e.forecast,
      previous: e.prev,
      reported_period: e.reported_period,
    }));

    if (rows.length > 0) {
      await withDbRetry(
        () =>
          bulkUpsert({
            sql,
            table: 'economic_events',
            columns: [
              'date',
              'event_name',
              'event_time',
              'event_type',
              'forecast',
              'previous',
              'reported_period',
            ],
            rows,
            conflictTarget: '(date, event_name, event_time)',
            conflictUpdateColumns: [],
          }),
        2,
        10_000,
      );
    }

    // Data quality check: alert if API returned events but all key fields are null
    if (todayEvents.length > 0) {
      const qcRows = await withDbRetry(
        () => sql`
          SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (
                   WHERE event_name IS NOT NULL AND event_name != ''
                 ) AS has_name
          FROM economic_events
          WHERE date = ${todayStr}
        `,
        2,
        10_000,
      );
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
        // Not in AXIOM_TOP_LEVEL_KEYS, so it lands in the Axiom `meta` string.
        invalidTimeSkipped,
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
