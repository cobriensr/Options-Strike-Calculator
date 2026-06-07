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

/**
 * Run a Redis operation, swallowing ANY throw: on error it increments the
 * `redis.error` metric and returns `fallback`. Centralizes the
 * "best-effort KV, never crash the request" pattern that callers previously
 * duplicated with their own try/catch + `metrics.increment('redis.error')`.
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
  } catch {
    metrics.increment('redis.error');
    return fallback;
  }
}
