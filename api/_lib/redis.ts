/**
 * Neutral Upstash Redis client + KV helpers.
 *
 * This is the LOWER layer: it owns the shared `redis` singleton and a
 * swallow-and-metric wrapper, with NO dependency on the auth/OAuth module
 * (`schwab.ts`). `schwab.ts` and other callers import `redis` from here.
 * Keeping the singleton out of the auth module avoids inverting the layering
 * (generic KV cache helpers should not transitively pull OAuth logic).
 *
 * When created via Vercel Marketplace, these env vars are auto-set:
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 *
 * Uses the REST-based client (no persistent connections needed).
 */

import { Redis } from '@upstash/redis';
import logger from './logger.js';
import { metrics } from './sentry.js';
import { requireEnvGroup } from './env.js';

/**
 * Build the Upstash Redis client. Falls back to an unconfigured client that
 * fails at runtime (rather than at import) when the env vars are absent — this
 * keeps non-Redis code paths importable in environments without KV.
 */
export function createRedis(): Redis {
  try {
    const { url, token } = requireEnvGroup('redis');
    return new Redis({ url, token });
  } catch {
    logger.warn('Redis not configured — operations will fail at runtime');
    return new Redis({ url: '', token: '' });
  }
}

/**
 * Shared Upstash Redis singleton. Imported by `schwab.ts` (token storage +
 * locks), `last-good-cache.ts`, the UW rate-limit / concurrency limiters, and
 * the auth/cron helpers. The REST client holds no persistent connection, so a
 * single module-scoped instance is safe across serverless invocations.
 */
export const redis = createRedis();

// ============================================================
// ERROR CLASSIFICATION (quota vs outage)
// ============================================================

/**
 * Substring Upstash puts in the REST error when the plan's command quota is
 * exhausted, e.g. `ERR max requests limit exceeded. Limit: 500000, Usage:
 * 500000`. Matched case-insensitively against the error message.
 */
const QUOTA_MARKER = 'max requests limit exceeded';

/**
 * True when `err` is Upstash's over-quota rejection. Accepts an `Error`, a
 * bare string throw, or any error-like `{ message }` object — the REST client
 * has surfaced the quota message in more than one shape.
 *
 * Over-quota is NOT an outage: every command fails with this exact error
 * until the billing window resets (or the plan is upgraded). Callers use it
 * to degrade quietly (cache miss, limiter fail-open, `/api/health` →
 * `degraded`) instead of paging as if Redis were down.
 */
export function isQuotaError(err: unknown): boolean {
  let message: string | undefined;
  if (typeof err === 'string') message = err;
  else if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === 'string') message = m;
  }
  return message !== undefined && message.toLowerCase().includes(QUOTA_MARKER);
}

let quotaWarned = false;

/** Reset the once-per-process quota warn latch. Exported for tests only. */
export function _resetQuotaWarnForTests(): void {
  quotaWarned = false;
}

/**
 * Record a failed Redis operation in metrics, classifying it first:
 *
 *   - quota error → `redis.quota_exceeded` counter (every occurrence) plus
 *     ONE `warn` log per process on first sight. No Sentry exception — when
 *     the quota trips, every command in every lambda fails the same way and
 *     a per-call capture would be a storm that says nothing new.
 *   - anything else → the generic `redis.error` counter (unchanged).
 *
 * The two counters are disjoint on purpose: `redis.error` stays the
 * "misconfigured / down" signal, `redis.quota_exceeded` is cost/capacity.
 *
 * Returns the classification so callers that still want their own handling
 * (e.g. the rate limiter's Sentry capture) can skip it for quota errors.
 */
export function recordRedisError(err: unknown): 'quota' | 'error' {
  if (isQuotaError(err)) {
    metrics.increment('redis.quota_exceeded');
    if (!quotaWarned) {
      quotaWarned = true;
      logger.warn(
        { err },
        'Upstash Redis command quota exceeded — every Redis op in this process will fail until the window resets or the plan is upgraded; callers degrade to cache-miss / fail-open',
      );
    }
    return 'quota';
  }
  metrics.increment('redis.error');
  return 'error';
}

/**
 * Run a Redis operation, swallowing ANY throw: on error it records the
 * failure via {@link recordRedisError} (`redis.error`, or
 * `redis.quota_exceeded` for Upstash's over-quota rejection) and returns
 * `fallback`. Centralizes the "best-effort KV, never crash the request"
 * pattern that callers previously duplicated with their own try/catch +
 * `metrics.increment('redis.error')`.
 *
 * @param op       the Redis operation to run.
 * @param fallback the value to return if `op` throws.
 */
export async function safeRedis<T>(
  op: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await op();
  } catch (err) {
    recordRedisError(err);
    return fallback;
  }
}

/**
 * Void-returning convenience wrapper over {@link safeRedis} for best-effort
 * write paths (e.g. `writeLastGood`) that have no meaningful return value, so
 * callers don't thread an explicit `undefined` fallback sentinel.
 */
export async function safeRedisVoid(op: () => Promise<void>): Promise<void> {
  await safeRedis(op, undefined);
}
