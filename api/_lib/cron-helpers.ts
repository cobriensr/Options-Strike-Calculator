/**
 * Cron-job preamble + market-hours gating + post-fetch data quality
 * helpers shared by every scheduled handler.
 *
 * `cronGuard` is the standard "method + CRON_SECRET + time-window +
 * UW_API_KEY" preamble. `cronJitter` spreads top-of-minute bursts so
 * the UW concurrency cap doesn't 429. `isMarketHours` / `isMarketOpen`
 * gate work to RTH (with a 5-min buffer for `isMarketHours`).
 * `checkDataQuality` fires a Sentry warning when an upstream fetch
 * structurally succeeds but contains all-zero payloads.
 *
 * Split from `api-helpers.ts` (Phase 2 of api-refactor-2026-05-02).
 * Re-exported from `api-helpers.ts` for backward compatibility.
 */

import { timingSafeEqual } from 'node:crypto';

import type { VercelRequest, VercelResponse } from '@vercel/node';

import { MARKET_MINUTES } from './constants.js';
import logger from './logger.js';
import { getMarketCloseHourET } from '../../src/data/marketHours.js';
import {
  getETTime,
  getETDayOfWeek,
  getETDateStr,
} from '../../src/utils/timezone.js';

// ============================================================
// MARKET HOURS CHECKS
// ============================================================

/**
 * Check if current time is within extended market hours.
 * Uses isMarketOpen() (holiday/early-close aware) with a 5-minute buffer
 * on each side so cron jobs running at :00 catch data at open/close.
 */
export function isMarketHours(): boolean {
  const now = new Date();
  const day = getETDayOfWeek(now);
  if (day === 0 || day === 6) return false;

  const dateStr = getETDateStr(now);
  const closeHour = getMarketCloseHourET(dateStr);
  if (closeHour == null) return false; // holiday

  const { hour, minute } = getETTime(now);
  const totalMin = hour * 60 + minute;
  const closeMin = closeHour * 60;
  // 5-minute buffer: 9:25 AM (565) to close + 5 min
  return totalMin >= MARKET_MINUTES.OPEN - 5 && totalMin <= closeMin + 5;
}

/**
 * Check if US equity markets are currently open.
 * Accounts for weekends, holidays, and early-close days
 * using the event calendar. Used to adjust cache durations.
 */
export function isMarketOpen(): boolean {
  const now = new Date();
  const day = getETDayOfWeek(now);
  if (day === 0 || day === 6) return false;

  // Check holidays and early closes via event calendar
  const dateStr = getETDateStr(now);
  const closeHour = getMarketCloseHourET(dateStr);
  if (closeHour == null) return false; // market closed (holiday)

  const { hour, minute } = getETTime(now);
  const totalMin = hour * 60 + minute;
  const closeMin = closeHour * 60;
  // Market: 9:30 AM (570) to close (960 normal, 780 early)
  return totalMin >= MARKET_MINUTES.OPEN && totalMin <= closeMin;
}

// ============================================================
// CRON GUARD
// ============================================================

interface CronGuardOptions {
  /** Check isMarketHours(). Default: true. */
  marketHours?: boolean;
  /** Custom time-window check. Overrides marketHours when provided. */
  timeCheck?: () => boolean;
  /** Require UW_API_KEY. Default: true. */
  requireApiKey?: boolean;
}

interface CronGuardResult {
  apiKey: string;
  today: string;
}

/**
 * Common guard for cron handlers. Checks method, CRON_SECRET,
 * time window, and API key. Returns `{ apiKey, today }` on success,
 * or sends an error response and returns `null`.
 *
 * Manual one-shot runs can pass `?force=1` to skip the time-window
 * check (CRON_SECRET is still required). Useful for backfilling state
 * after a late deploy without waiting for the next scheduled fire.
 *
 * Usage:
 * ```ts
 * const guard = cronGuard(req, res);
 * if (!guard) return;
 * const { apiKey, today } = guard;
 * ```
 */
export function cronGuard(
  req: VercelRequest,
  res: VercelResponse,
  opts: CronGuardOptions = {},
): CronGuardResult | null {
  const {
    marketHours: checkMarket = true,
    timeCheck,
    requireApiKey = true,
  } = opts;

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'GET only' });
    return null;
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  const authHeader = req.headers.authorization ?? '';
  const expected = `Bearer ${cronSecret}`;
  const authBuf = Buffer.from(authHeader);
  const expBuf = Buffer.from(expected);
  if (authBuf.length !== expBuf.length || !timingSafeEqual(authBuf, expBuf)) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }

  // Time window check. `?force=1` bypasses the time gate for one-shot
  // manual runs (e.g. backfilling forward returns after a late deploy).
  // The auth check above still gates everything — `force` only relaxes
  // the schedule, never CRON_SECRET.
  const force = req.query?.force === '1';
  const customCheck = timeCheck ?? (checkMarket ? isMarketHours : null);
  if (!force && customCheck && !customCheck()) {
    res.status(200).json({ skipped: true, reason: 'Outside time window' });
    return null;
  }

  const apiKey = requireApiKey ? (process.env.UW_API_KEY ?? '') : '';
  if (requireApiKey && !apiKey) {
    logger.error('UW_API_KEY not configured');
    res.status(500).json({ error: 'UW_API_KEY not configured' });
    return null;
  }

  const today = getETDateStr(new Date());
  return { apiKey, today };
}

/**
 * Sleep a randomized 0–maxMs to spread top-of-minute cron bursts.
 *
 * Vercel cron schedules fire at second :00 of the scheduled minute, so
 * every cron with `* 13-21 * * 1-5` collides at the same instant. With
 * 12+ such handlers all calling UW, the per-second concurrency cap (3
 * — see `uw-rate-limit.ts`) is overrun and the rest 429.
 *
 * Calling this right after `cronGuard()` spreads the burst across the
 * window so the rate limiter rarely needs to queue. Pair with
 * `acquireUWSlot()` for belt-and-suspenders concurrency control.
 *
 * No-op under Vitest so handler tests stay fast and deterministic.
 *
 * @param maxMs - Upper bound of the random delay. Default 8000ms.
 */
export function cronJitter(maxMs: number = 8000): Promise<void> {
  if (process.env.VITEST) return Promise.resolve();
  const delay = Math.floor(Math.random() * maxMs);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

// ============================================================
// DATA QUALITY CHECKS
// ============================================================

interface DataQualityOptions {
  /** Cron job name for Sentry tag */
  job: string;
  /** Table to query */
  table: string;
  /** Date to check */
  date: string;
  /** SQL WHERE condition for the source (e.g., "source = 'spy_etf_tide'") */
  sourceFilter?: string;
  /** SQL expression that should be non-zero for valid rows */
  nonzeroExpr: string;
  /** Minimum rows before alerting (default: 10) */
  minRows?: number;
}

/**
 * Check if stored data has all zero/null values and fire a Sentry
 * warning if so. Catches upstream API issues where the response is
 * structurally valid but contains empty data.
 *
 * Pass in the total and nonzero counts (computed by the caller with
 * a tagged template query) rather than building dynamic SQL here.
 */
export async function checkDataQuality(
  opts: Omit<DataQualityOptions, 'nonzeroExpr'> & {
    total: number;
    nonzero: number;
  },
): Promise<void> {
  const { job, table, date, sourceFilter, total, nonzero, minRows = 10 } = opts;

  if (total > minRows && nonzero === 0) {
    const { Sentry } = await import('./sentry.js');
    Sentry.setTag('cron.job', job);
    const label = sourceFilter ?? table;
    Sentry.captureMessage(
      `Data quality alert: ${label} has ${total} rows but ALL values are zero/null for ${date}`,
      'warning',
    );
    logger.warn({ job, table, total, date }, 'Data quality: all values zero');
  }
}
