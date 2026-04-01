/**
 * Shared helper for making authenticated Schwab API calls.
 * Used by the three data endpoints (quotes, intraday, yesterday).
 *
 * OWNER GATING: All data endpoints require a session cookie set
 * during the Schwab OAuth flow. Public visitors get a 401 and the
 * frontend silently falls back to manual input.
 */

import { timingSafeEqual } from 'node:crypto';

import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Discriminated union for internal API call results.
 * Use `result.ok` to narrow the type instead of `'error' in result`.
 */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status: number; code?: string };
import { checkBotId } from 'botid/server';
import { getAccessToken, redis } from './schwab.js';
import { MARKET_MINUTES, TIMEOUTS, UW_BASE } from './constants.js';
import logger from './logger.js';
import { metrics } from './sentry.js';
import { getMarketCloseHourET } from '../../src/data/marketHours.js';
import {
  getETTime,
  getETDayOfWeek,
  getETDateStr,
} from '../../src/utils/timezone.js';

const SCHWAB_BASE = 'https://api.schwabapi.com/marketdata/v1';
const SCHWAB_TRADER_BASE = 'https://api.schwabapi.com/trader/v1';

// ============================================================
// BOT PROTECTION
// ============================================================

/**
 * Wrapper around checkBotId.
 * Skips the check entirely in local dev — botid requires client-side tokens
 * that aren't present outside Vercel's infrastructure, producing terminal spam.
 * VERCEL=1 is set automatically by Vercel; it's unset in local dev.
 */
export async function checkBot(
  req: VercelRequest,
): Promise<{ isBot: boolean }> {
  if (!process.env.VERCEL) return { isBot: false };
  return checkBotId({ advancedOptions: { headers: req.headers } });
}

// ============================================================
// OWNER VERIFICATION
// ============================================================

/**
 * Cookie name for the owner session.
 * Set during /api/auth/callback, checked on every data request.
 */
export const OWNER_COOKIE = 'sc-owner';

/**
 * Max age for the owner cookie (7 days — matches Schwab refresh token).
 */
export const OWNER_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;

/**
 * Parse cookies from the request header.
 * Vercel's VercelRequest doesn't always parse cookies automatically.
 */
function parseCookies(req: VercelRequest): Record<string, string> {
  const header = req.headers.cookie || '';
  const cookies: Record<string, string> = {};
  for (const pair of header.split(';')) {
    const [key, ...rest] = pair.trim().split('=');
    if (key) cookies[key] = rest.join('=');
  }
  return cookies;
}

let ownerSecretWarned = false;

/**
 * Verify that the request is from the site owner.
 * Returns true if the owner cookie matches OWNER_SECRET.
 * Returns false for public visitors — the endpoint should return 401.
 */
export function isOwner(req: VercelRequest): boolean {
  const secret = process.env.OWNER_SECRET;
  if (!secret) {
    if (!ownerSecretWarned && process.env.VERCEL) {
      ownerSecretWarned = true;
      logger.warn(
        'OWNER_SECRET is not set — all requests will get 401',
      );
    }
    return false;
  }

  const cookies = parseCookies(req);
  const cookieVal = cookies[OWNER_COOKIE] ?? '';
  const a = Buffer.from(cookieVal);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Guard a data endpoint. Call at the top of every handler.
 * Returns true if the request should be rejected (response already sent).
 */
export function rejectIfNotOwner(
  req: VercelRequest,
  res: VercelResponse,
): boolean {
  if (!isOwner(req)) {
    const cookies = parseCookies(req);
    const hasCookie = OWNER_COOKIE in cookies && cookies[OWNER_COOKIE] !== '';
    const reason = !process.env.OWNER_SECRET
      ? 'no_secret'
      : hasCookie
        ? 'cookie_mismatch'
        : 'no_cookie';
    logger.warn(
      {
        path: req.url,
        reason,
        referer: req.headers.referer ?? null,
        ua: req.headers['user-agent']?.slice(0, 80) ?? null,
      },
      `401 owner check failed: ${reason}`,
    );
    // Don't cache 401s at the edge — each request should check the cookie
    res.setHeader('Cache-Control', 'no-store');
    res.status(401).json({ error: 'Not authenticated', code: reason });
    return true;
  }
  return false;
}

/**
 * Standard error response format.
 * All API endpoints should use this for error responses.
 */
export function sendError(
  res: VercelResponse,
  status: number,
  message: string,
  code?: string,
): void {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json({
    error: message,
    ...(code && { code }),
  });
}

// ============================================================
// RATE LIMITING
// ============================================================

/**
 * Check if a request should be rate-limited.
 * Uses Upstash Redis to track request counts per key per minute.
 *
 * Used on auth endpoints to prevent brute-force and abuse.
 * Fails open (returns false) if Redis is unavailable — don't block
 * legitimate requests if the rate limiter itself is down.
 *
 * @param key - Unique identifier (e.g. IP address, endpoint name)
 * @param maxPerMinute - Maximum requests allowed per 60-second window
 * @returns true if the request should be blocked
 */
async function isRateLimited(
  key: string,
  maxPerMinute: number = 5,
): Promise<boolean> {
  try {
    const redisKey = `ratelimit:${key}`;
    const pipe = redis.pipeline();
    pipe.incr(redisKey);
    pipe.expire(redisKey, 60);
    const results = await pipe.exec();
    const count = results[0] as number;
    return count > maxPerMinute;
  } catch {
    return false; // fail open
  }
}

/**
 * Extract a rate-limit key from the request.
 * Uses X-Real-Ip (set by Vercel), then X-Forwarded-For, then 'unknown'.
 */
function getRateLimitKey(req: VercelRequest, endpoint: string): string {
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp) return `${endpoint}:${realIp}`;

  const forwarded = req.headers['x-forwarded-for'];
  const ip =
    typeof forwarded === 'string'
      ? (forwarded.split(',')[0]?.trim() ?? 'unknown')
      : 'unknown';
  return `${endpoint}:${ip}`;
}

/**
 * Guard an endpoint with rate limiting.
 * Returns true if the request was rejected (response already sent).
 */
export async function rejectIfRateLimited(
  req: VercelRequest,
  res: VercelResponse,
  endpoint: string,
  maxPerMinute: number = 5,
): Promise<boolean> {
  const key = getRateLimitKey(req, endpoint);
  const limited = await isRateLimited(key, maxPerMinute);
  if (limited) {
    metrics.rateLimited(endpoint);
    res.setHeader('Retry-After', '60');
    res
      .status(429)
      .json({ error: 'Too many requests. Try again in 60 seconds.' });
    return true;
  }
  return false;
}

// ============================================================
// SCHWAB API FETCH
// ============================================================

/**
 * Make an authenticated GET request to a Schwab API endpoint.
 * Handles token retrieval and error responses.
 */
async function schwabApiFetch<T>(
  base: string,
  path: string,
): Promise<ApiResult<T>> {
  const authResult = await getAccessToken();

  if ('error' in authResult) {
    metrics.tokenRefresh(false);
    const status = authResult.error.type === 'expired_refresh' ? 401 : 500;
    const code =
      authResult.error.type === 'expired_refresh'
        ? 'SCHWAB_TOKEN_EXPIRED'
        : 'SCHWAB_TOKEN_ERROR';
    return {
      ok: false,
      error: `[${code}] ${authResult.error.message}`,
      status,
    };
  }

  const endpoint = path.split('?')[0] ?? path;
  const done = metrics.schwabCall(endpoint);

  const url = `${base}${path}`;
  const MAX_RETRIES = 2;
  let res: Response | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${authResult.token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(TIMEOUTS.SCHWAB_API),
    });

    if (res.ok || res.status < 500) break;

    if (attempt < MAX_RETRIES) {
      logger.warn(
        { status: res.status, attempt, endpoint },
        'Schwab transient error, retrying',
      );
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }

  if (!res!.ok) {
    done(false);
    const body = await res!.text();
    const code =
      res!.status === 401 ? 'SCHWAB_API_REJECTED' : `SCHWAB_API_${res!.status}`;
    return {
      ok: false,
      error: `[${code}] Schwab API error (${res!.status}): ${body}`,
      status: res!.status === 401 ? 401 : res!.status === 429 ? 429 : 502,
    };
  }

  done(true);
  const data: T = await res!.json();
  return { ok: true, data };
}

/** Authenticated GET to the Schwab Market Data API. */
export function schwabFetch<T>(path: string): Promise<ApiResult<T>> {
  return schwabApiFetch(SCHWAB_BASE, path);
}

/** Authenticated GET to the Schwab Trader API (accounts, orders, positions). */
export function schwabTraderFetch<T>(path: string): Promise<ApiResult<T>> {
  return schwabApiFetch(SCHWAB_TRADER_BASE, path);
}

// ============================================================
// MARKET HOURS CHECKS
// ============================================================

/** Check if current time is within extended market hours (9:25 AM - 4:05 PM ET). */
export function isMarketHours(): boolean {
  const now = new Date();
  const et = new Date(
    now.toLocaleString('en-US', { timeZone: 'America/New_York' }),
  );
  const day = et.getDay();
  if (day === 0 || day === 6) return false;

  const hour = et.getHours();
  const minute = et.getMinutes();
  const timeMinutes = hour * 60 + minute;

  return timeMinutes >= 565 && timeMinutes <= 965;
}

// ============================================================
// CACHE + MARKET HOURS
// ============================================================

/**
 * Set cache headers on the response.
 *
 * IMPORTANT: These headers cache at Vercel's edge, keyed by URL + Cookie.
 * Because the owner cookie is required, cached responses are only served
 * to the same authenticated session — not to public visitors.
 *
 * We add Vary: Cookie to ensure the edge doesn't serve an owner's cached
 * response to a public visitor (who would get a 401 instead).
 */
export function setCacheHeaders(
  res: VercelResponse,
  edgeSec: number,
  swr: number = 60,
): void {
  res.setHeader(
    'Cache-Control',
    `s-maxage=${edgeSec}, stale-while-revalidate=${swr}`,
  );
  res.setHeader('Vary', 'Cookie');
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
// RETRY HELPER (for transient Neon / network failures)
// ============================================================

/**
 * Retry an async operation with exponential backoff.
 * Only retries on transient errors (timeouts, connection resets).
 * Non-transient errors (bad SQL, constraint violations) throw immediately.
 *
 * Designed for cron jobs where a single missed invocation creates data gaps.
 * Interactive endpoints should NOT use this — users want fast failure.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number = 2,
): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt === retries;
      const msg = err instanceof Error ? err.message : '';
      const isTransient =
        /timeout|ECONNREFUSED|ECONNRESET|fetch failed|socket hang up|50[234]/i.test(
          msg,
        );
      if (isLast || !isTransient) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw new Error('unreachable');
}

// ============================================================
// UNUSUAL WHALES API HELPERS
// ============================================================

/**
 * Fetch JSON from the Unusual Whales API.
 *
 * Handles auth header, timeout, non-OK responses, and returns the
 * parsed `body.data` array. For endpoints with nested data structures
 * (e.g., net-flow/expiry returns `data[0].data`), use the `extract`
 * parameter to customize the extraction.
 *
 * @param apiKey - UW API key
 * @param path - path after UW_BASE (e.g., "/market/SPY/etf-tide")
 * @param extract - optional function to extract data from response body
 */
export async function uwFetch<T>(
  apiKey: string,
  path: string,
  extract?: (body: Record<string, unknown>) => T[],
): Promise<T[]> {
  const url = path.startsWith('http') ? path : `${UW_BASE}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(TIMEOUTS.UW_API),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`UW API ${res.status}: ${text.slice(0, 200)}`);
  }

  const body = await res.json();
  return extract ? extract(body) : (body.data ?? []);
}

/**
 * Round a Date to the nearest 5-minute boundary (floor).
 *
 * Used by all flow/GEX crons to sample intraday ticks at consistent
 * 5-minute intervals. Returns a new Date — does not mutate input.
 */
export function roundTo5Min(dt: Date): Date {
  const rounded = new Date(dt);
  const minutes = rounded.getMinutes();
  rounded.setMinutes(minutes - (minutes % 5), 0, 0);
  return rounded;
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
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }

  // Time window check
  const customCheck = timeCheck ?? (checkMarket ? isMarketHours : null);
  if (customCheck && !customCheck()) {
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
