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
  | { ok: false; error: string; status: number };
import { checkBotId } from 'botid/server';
import { getAccessToken, redis } from './schwab.js';
import { MARKET_MINUTES, TIMEOUTS } from './constants.js';
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
      console.warn('[api-helpers] OWNER_SECRET is not set — all requests will get 401');
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
    // Don't cache 401s at the edge — each request should check the cookie
    res.setHeader('Cache-Control', 'no-store');
    res.status(401).json({ error: 'Not authenticated' });
    return true;
  }
  return false;
}

/**
 * HTTP error class for use with requireOwner and other throwing guards.
 */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Throwing guard — use in try/catch handlers.
 * Throws HttpError(401) if the request isn't from the owner.
 */
export function requireOwner(req: VercelRequest): void {
  if (!isOwner(req)) {
    throw new HttpError(401, 'Not authenticated');
  }
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
export async function isRateLimited(
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
export function getRateLimitKey(req: VercelRequest, endpoint: string): string {
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
    return { ok: false, error: authResult.error.message, status };
  }

  const endpoint = path.split('?')[0] ?? path;
  const done = metrics.schwabCall(endpoint);

  const url = `${base}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${authResult.token}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(TIMEOUTS.SCHWAB_API),
  });

  if (!res.ok) {
    done(false);
    const body = await res.text();
    return {
      ok: false,
      error: `Schwab API error (${res.status}): ${body}`,
      status: res.status === 401 ? 401 : res.status === 429 ? 429 : 502,
    };
  }

  done(true);
  const data: T = await res.json();
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
        /timeout|ECONNREFUSED|ECONNRESET|fetch failed|socket hang up/i.test(
          msg,
        );
      if (isLast || !isTransient) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw new Error('unreachable');
}
