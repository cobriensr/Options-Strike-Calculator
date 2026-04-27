/**
 * Market-hours scheduler for the TRACE Live capture daemon.
 *
 * Fires the capture cycle every CADENCE_MS ms during the trading window:
 *   - 8:35 AM CT → 2:55 PM CT (= 9:35 AM ET → 3:55 PM ET)
 *   - Weekdays only (Mon–Fri)
 *   - Skips NYSE-closed full holidays (calendar copied from
 *     src/data/marketHours.ts — keep in lock-step at year boundaries)
 *
 * On half-day sessions (1 PM ET close) the daemon stops at 12:55 ET.
 * Half-day detection uses the same calendar.
 *
 * Skip-if-running guard: each capture run gets a token; if the previous
 * run hasn't returned by the next tick, the new tick is logged and
 * skipped. Without this, slow API responses would queue up and quickly
 * exceed the browserless concurrent-session limit (5 on Prototyping).
 */

import type { Logger } from 'pino';

// ============================================================
// Holiday calendar — copied from src/data/marketHours.ts.
// Update both when a new year's NYSE schedule is published.
// ============================================================

const EARLY_CLOSE_DATES: ReadonlyMap<string, number> = new Map([
  // 2025
  ['2025-07-03', 13],
  ['2025-11-28', 13],
  ['2025-12-24', 13],
  // 2026
  ['2026-11-27', 13],
  ['2026-12-24', 13],
]);

const MARKET_CLOSED_DATES: ReadonlySet<string> = new Set([
  // 2025
  '2025-04-18',
  '2025-05-26',
  '2025-06-19',
  '2025-07-04',
  '2025-09-01',
  '2025-11-27',
  '2025-12-25',
  // 2026
  '2026-01-01',
  '2026-01-19',
  '2026-02-16',
  '2026-04-03',
  '2026-05-25',
  '2026-06-19',
  '2026-07-03',
  '2026-09-07',
  '2026-11-26',
  '2026-12-25',
]);

// ============================================================
// ET-aware time helpers
// ============================================================

const ET_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const ET_PARTS_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
  hour12: false,
});

function getETDate(d: Date): string {
  return ET_DATE_FMT.format(d);
}

function getETMinutesAndWeekday(d: Date): {
  minutes: number;
  weekday: string;
} {
  const parts = ET_PARTS_FMT.formatToParts(d);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  return {
    minutes: (hour === 24 ? 0 : hour) * 60 + minute,
    weekday,
  };
}

// ============================================================
// Window logic
// ============================================================

/** Daemon-window opens at 9:35 ET (8:35 CT) — 5 min after market open. */
const WINDOW_OPEN_MIN = 9 * 60 + 35;

/** Default close: 15:55 ET (14:55 CT) — 5 min before market close. */
const WINDOW_CLOSE_MIN_FULL = 15 * 60 + 55;

/** Half-day close: 12:55 ET — 5 min before the 13:00 close. */
const WINDOW_CLOSE_MIN_HALF = 12 * 60 + 55;

const WEEKEND_WEEKDAYS = new Set(['Sat', 'Sun']);

export interface MarketHoursStatus {
  inWindow: boolean;
  reason: string;
  etDate: string;
  etMinutes: number;
}

export function checkMarketHours(now: Date = new Date()): MarketHoursStatus {
  const etDate = getETDate(now);
  const { minutes, weekday } = getETMinutesAndWeekday(now);

  if (WEEKEND_WEEKDAYS.has(weekday)) {
    return {
      inWindow: false,
      reason: `weekend (${weekday})`,
      etDate,
      etMinutes: minutes,
    };
  }
  if (MARKET_CLOSED_DATES.has(etDate)) {
    return {
      inWindow: false,
      reason: `market closed: ${etDate}`,
      etDate,
      etMinutes: minutes,
    };
  }

  const isHalfDay = EARLY_CLOSE_DATES.has(etDate);
  const closeMin = isHalfDay ? WINDOW_CLOSE_MIN_HALF : WINDOW_CLOSE_MIN_FULL;

  if (minutes < WINDOW_OPEN_MIN) {
    return {
      inWindow: false,
      reason: 'pre-window',
      etDate,
      etMinutes: minutes,
    };
  }
  if (minutes >= closeMin) {
    return {
      inWindow: false,
      reason: isHalfDay ? 'post-window (half-day)' : 'post-window',
      etDate,
      etMinutes: minutes,
    };
  }

  return {
    inWindow: true,
    reason: isHalfDay ? 'in window (half-day)' : 'in window',
    etDate,
    etMinutes: minutes,
  };
}

// ============================================================
// Scheduler
// ============================================================

export interface SchedulerOptions {
  cadenceMs: number;
  bypassMarketHoursGate: boolean;
  logger: Logger;
  /** The capture function — fired each tick when in-window. */
  onTick: () => Promise<void>;
}

export interface Scheduler {
  start: () => void;
  stop: () => void;
}

/**
 * Build a market-hours-gated scheduler. Returns control immediately;
 * the caller pumps the loop via .start() and tears it down via .stop().
 */
export function createScheduler(opts: SchedulerOptions): Scheduler {
  const { cadenceMs, bypassMarketHoursGate, logger, onTick } = opts;
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;
  let consecutiveSkips = 0;

  async function tick(): Promise<void> {
    const status = checkMarketHours();
    if (!bypassMarketHoursGate && !status.inWindow) {
      // Quiet outside window — log every 12th skip (~hourly at 5-min cadence).
      if (consecutiveSkips % 12 === 0) {
        logger.info(
          {
            etDate: status.etDate,
            etMinutes: status.etMinutes,
            reason: status.reason,
          },
          'Outside daemon window — sleeping',
        );
      }
      consecutiveSkips++;
      return;
    }
    consecutiveSkips = 0;

    if (inFlight) {
      logger.warn(
        'Previous capture still running — skipping this tick (skip-if-running guard)',
      );
      return;
    }

    inFlight = true;
    const startedAt = Date.now();
    try {
      await onTick();
      logger.info(
        { durationMs: Date.now() - startedAt },
        'Capture cycle complete',
      );
    } catch (err) {
      logger.error(
        { err, durationMs: Date.now() - startedAt },
        'Capture cycle failed',
      );
    } finally {
      inFlight = false;
    }
  }

  function start(): void {
    logger.info(
      {
        cadenceMs,
        cadenceSec: cadenceMs / 1000,
        bypassMarketHoursGate,
      },
      'Scheduler starting',
    );
    void tick();
    timer = setInterval(() => void tick(), cadenceMs);
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    logger.info('Scheduler stopped');
  }

  return { start, stop };
}
