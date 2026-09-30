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

import { Redis, type RedisConfigNodejs } from '@upstash/redis';
import logger from './logger.js';
import { metrics } from './sentry.js';
import { requireEnvGroup } from './env.js';

/** Per-client transport tuning layered over the env-derived url/token. */
type RedisTuning = Pick<RedisConfigNodejs, 'retry' | 'signal'>;

/**
 * Build the Upstash Redis client. Falls back to an unconfigured client that
 * fails at runtime (rather than at import) when the env vars are absent — this
 * keeps non-Redis code paths importable in environments without KV.
 *
 * @param tuning optional retry / abort-signal overrides; omitted, the client
 *               keeps Upstash's defaults.
 */
export function createRedis(tuning: RedisTuning = {}): Redis {
  try {
    const { url, token } = requireEnvGroup('redis');
    return new Redis({ url, token, ...tuning });
  } catch {
    logger.warn('Redis not configured — operations will fail at runtime');
    return new Redis({ url: '', token: '', ...tuning });
  }
}

/**
 * Shared Upstash Redis singleton. Imported by `schwab.ts` (token storage +
 * locks), `last-good-cache.ts`, and the auth/cron helpers. The REST client
 * holds no persistent connection, so a single module-scoped instance is safe
 * across serverless invocations. Keeps Upstash's default retry/backoff.
 */
export const redis = createRedis();

/**
 * Fail-fast client for the UW rate-limit and concurrency limiters, which
 * both fail OPEN on any Redis error. On Upstash defaults (5 retries with
 * exponential backoff, undici's 10 s connect timeout) one limiter call took
 * ~64 s to give up during the 2026-09-29 connect-timeout outage, and
 * `uwFetch` makes up to three of them per UW request — stalling crons for
 * minutes and dropping minute snapshots. Here a call either answers within
 * 1.5 s (normal latency is single-digit ms) or throws, so the limiter fails
 * open after one attempt:
 *
 *   - `retry: { retries: 0 }` — exactly one fetch. (Note `retry: false`
 *     would still make TWO: Upstash maps it to `attempts: 1` and loops
 *     `i <= attempts`.)
 *   - `signal` is a FUNCTION so Upstash mints a fresh timeout per request.
 *     A shared static signal would stay aborted after the first timeout,
 *     and on an aborted static signal Upstash fabricates an HTTP 200
 *     `{ result: "Aborted" }` instead of throwing; with the function form it
 *     rethrows the abort error, which the limiters' catch handles.
 */
export const limiterRedis = createRedis({
  retry: { retries: 0 },
  signal: () => AbortSignal.timeout(1_500),
});

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

/**
 * Void-returning convenience wrapper over {@link safeRedis} for best-effort
 * write paths (e.g. `writeLastGood`) that have no meaningful return value, so
 * callers don't thread an explicit `undefined` fallback sentinel.
 */
export async function safeRedisVoid(op: () => Promise<void>): Promise<void> {
  await safeRedis(op, undefined);
}
