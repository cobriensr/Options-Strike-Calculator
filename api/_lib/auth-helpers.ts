/**
 * Owner-cookie auth, bot protection, request guards, and edge-cache /
 * error-response helpers shared across every data endpoint.
 *
 * OWNER GATING: All data endpoints require a session cookie set during
 * the Schwab OAuth flow. Public visitors get a 401 and the frontend
 * silently falls back to manual input.
 *
 * Split from `api-helpers.ts` (Phase 2 of api-refactor-2026-05-02).
 * Re-exported from `api-helpers.ts` for backward compatibility.
 */

import { timingSafeEqual } from 'node:crypto';

import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { ZodSafeParseResult, ZodSafeParseError } from 'zod';
import { checkBotId } from 'botid/server';

import { redis, recordRedisError } from './redis.js';
import logger from './logger.js';
import { metrics, Sentry } from './sentry.js';

// ============================================================
// BOT PROTECTION
// ============================================================

/**
 * Wrapper around checkBotId.
 * Skips the check entirely in local dev — botid requires client-side tokens
 * that aren't present outside Vercel's infrastructure, producing terminal spam.
 * VERCEL=1 is set automatically by Vercel; it's unset in local dev.
 *
 * Also short-circuits for authenticated owner sessions. The `sc-owner` cookie
 * is a random secret set by the Schwab OAuth callback, compared with
 * `timingSafeEqual` against `OWNER_SECRET`. If a caller presents a valid
 * owner cookie, they have already cleared a strictly stronger authentication
 * gate than any anti-bot heuristic — running Vercel BotID on top is redundant
 * and produces false positives on privacy-respecting browsers (Firefox with
 * Enhanced Tracking Protection, DNT + Sec-GPC, etc.) that Kasada scores as
 * high-risk. Public / anonymous traffic still goes through the full BotID
 * challenge flow.
 */
export async function checkBot(
  req: VercelRequest,
): Promise<{ isBot: boolean }> {
  if (!process.env.VERCEL) return { isBot: false };
  if (isOwner(req)) return { isBot: false };
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
 *
 * Exported so guest-auth.ts can reuse it without duplicating the parser.
 */
export function parseCookies(req: VercelRequest): Record<string, string> {
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
      logger.warn('OWNER_SECRET is not set — all requests will get 401');
    }
    return false;
  }

  const cookies = parseCookies(req);
  const cookieVal = cookies[OWNER_COOKIE] ?? '';
  if (!cookieVal) return false;
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
// COMBINED GUARDS
// ============================================================

/**
 * Guard an owner-only endpoint against bots and non-owners.
 * Combines checkBot + rejectIfNotOwner into a single call.
 *
 * Returns `true` if the request was rejected (response already sent),
 * `false` if it passed both checks.
 *
 * Usage:
 * ```ts
 * const rejected = await guardOwnerEndpoint(req, res, done);
 * if (rejected) return;
 * ```
 */
export async function guardOwnerEndpoint(
  req: VercelRequest,
  res: VercelResponse,
  done: (opts: { status: number }) => void,
): Promise<boolean> {
  const botCheck = await checkBot(req);
  if (botCheck.isBot) {
    done({ status: 403 });
    res.status(403).json({ error: 'Access denied' });
    return true;
  }
  const ownerCheck = rejectIfNotOwner(req, res);
  if (ownerCheck) {
    done({ status: 401 });
    return true;
  }
  return false;
}

// ============================================================
// VALIDATION HELPERS
// ============================================================

/**
 * Send a 400 response if a Zod safeParse failed.
 * Returns `true` if the parse failed (response already sent),
 * `false` if it succeeded.
 *
 * Usage:
 * ```ts
 * const parsed = schema.safeParse(req.body);
 * if (respondIfInvalid(parsed, res, done)) return;
 * // parsed.data is now available
 * ```
 */
export function respondIfInvalid<T>(
  parsed: ZodSafeParseResult<T>,
  res: VercelResponse,
  done?: (opts: { status: number }) => void,
): parsed is ZodSafeParseError<T> {
  if (!parsed.success) {
    const firstError = parsed.error.issues[0];
    done?.({ status: 400 });
    res.status(400).json({
      error: firstError?.message ?? 'Invalid request body',
    });
    return true;
  }
  return false;
}

// ============================================================
// RATE LIMITING
// ============================================================

/** Fixed-window length for the per-IP rate limiter. */
const RATE_LIMIT_WINDOW_SEC = 60;

/**
 * Check if a request should be rate-limited.
 * Uses Upstash Redis to track request counts per key per minute.
 *
 * Used on auth endpoints to prevent brute-force and abuse.
 * Fails open (returns false) if Redis is unavailable — don't block
 * legitimate requests if the rate limiter itself is down.
 *
 * COMMAND BUDGET (Upstash bills per command): the original implementation
 * pipelined `INCR` + `EXPIRE` on every gated request — 2 commands, 1 round
 * trip. This version issues `INCR` alone and only follows up with `EXPIRE`
 * when the returned count is `1` (the first hit of a fresh window), so the
 * steady state is 1 command per request. Trade-offs, deliberately taken:
 *
 *   - The first hit of each window costs 2 round trips instead of 1 (a
 *     conditional cannot be expressed in a REST pipeline; `EVAL` would fold
 *     it back into one call but is a different command with its own
 *     semantics and was not adopted here). A few ms once per minute per key.
 *   - The two commands are no longer in one HTTP request, so `INCR` can
 *     succeed and `EXPIRE` fail (Redis blip, or the quota tripping exactly
 *     between them). That leaves a key with NO TTL, which would 429 that
 *     caller forever. `healStuckWindow` covers it: on the rejection path
 *     (already over the limit — the only path where it matters) we `TTL`
 *     the key and, if it reports `-1`, re-arm `EXPIRE`. Rejections are rare
 *     and belong to abusive anonymous callers, so the extra command there
 *     is a cost we accept for the self-heal.
 *
 * @param key - Unique identifier (e.g. IP address, endpoint name)
 * @param maxPerMinute - Maximum requests allowed per 60-second window
 * @returns true if the request should be blocked
 */
async function isRateLimited(
  key: string,
  maxPerMinute: number = 5,
): Promise<boolean> {
  const redisKey = `ratelimit:${key}`;
  try {
    const count = await redis.incr(redisKey);
    if (count === 1) {
      // First hit of the window — start the TTL. Hits 2..N skip this.
      await redis.expire(redisKey, RATE_LIMIT_WINDOW_SEC);
    }
    if (count <= maxPerMinute) return false;
    await healStuckWindow(redisKey);
    return true;
  } catch (err) {
    logger.warn({ err }, 'Rate limiter Redis call failed; failing open');
    metrics.increment('api_helpers.rate_limit_redis_error');
    // The Upstash over-quota rejection is already counted + warned once per
    // process by recordRedisError; a Sentry exception per gated request on
    // top would be a storm that says nothing new. Genuine outages still
    // get captured.
    if (recordRedisError(err) !== 'quota') Sentry.captureException(err);
    return false; // fail open
  }
}

/**
 * Re-arm the window TTL on a rate-limit key that lost it (see the
 * INCR/EXPIRE split discussion on {@link isRateLimited}). Only called on the
 * rejection path. Never throws — the verdict (limited) is already known and
 * a failure here must not flip it to fail-open.
 */
async function healStuckWindow(redisKey: string): Promise<void> {
  try {
    const ttl = await redis.ttl(redisKey);
    if (ttl !== -1) return; // -2 = gone, >=0 = live window
    await redis.expire(redisKey, RATE_LIMIT_WINDOW_SEC);
    logger.warn({ redisKey }, 'Rate limiter re-armed a stuck key (no TTL)');
    metrics.increment('api_helpers.rate_limit_window_healed');
  } catch (err) {
    logger.warn({ err, redisKey }, 'Rate limiter TTL self-heal failed');
  }
}

/**
 * True when the request carries `Authorization: Bearer <CRON_SECRET>` —
 * the same constant-time check `cronGuard` performs. Used to exempt cron
 * invocations from the per-IP limiter (they share one egress IP and would
 * otherwise throttle each other while eating Redis commands).
 */
function hasCronBearer(req: VercelRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Trusted callers bypass the rate limiter entirely (zero Redis commands):
 * a valid `sc-owner` cookie (already the strongest auth gate in the app) or
 * the cron bearer. Brute-force protection is for anonymous callers; the
 * owner's own SPA / cron traffic is the steady-state caller and was paying
 * 2 Redis commands per request for a check that exists to stop strangers.
 */
function isTrustedCaller(req: VercelRequest): boolean {
  return isOwner(req) || hasCronBearer(req);
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
 *
 * Skipped outright for trusted callers (valid `sc-owner` cookie or the
 * `CRON_SECRET` bearer) — see {@link isTrustedCaller}.
 */
export async function rejectIfRateLimited(
  req: VercelRequest,
  res: VercelResponse,
  endpoint: string,
  maxPerMinute: number = 5,
): Promise<boolean> {
  if (isTrustedCaller(req)) return false;
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
// CACHE HEADERS
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
 *
 * `browserSec` (optional, default 0) sets `max-age` for the browser cache —
 * without it, browsers store responses but must revalidate on every reuse
 * via If-None-Match. Opt-in per endpoint based on staleness tolerance.
 */
export function setCacheHeaders(
  res: VercelResponse,
  edgeSec: number,
  swr: number = 60,
  browserSec: number = 0,
): void {
  const directives: string[] = [];
  if (browserSec > 0) directives.push(`max-age=${browserSec}`);
  directives.push(`s-maxage=${edgeSec}`);
  directives.push(`stale-while-revalidate=${swr}`);
  res.setHeader('Cache-Control', directives.join(', '));
  res.setHeader('Vary', 'Cookie');
}

// ============================================================
// GUEST AUTH RE-EXPORTS
// ============================================================

// Endpoints that accept either owner sessions OR valid guest keys import
// these helpers via api-helpers (next to their existing rejectIfNotOwner
// imports) so the rename is a one-symbol swap. Logic lives in guest-auth.ts.

export {
  rejectIfNotOwnerOrGuest,
  guardOwnerOrGuestEndpoint,
  isOwnerOrGuest,
  isGuest,
} from './guest-auth.js';
