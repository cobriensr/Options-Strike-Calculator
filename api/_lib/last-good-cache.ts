/**
 * "Last-good" Redis cache for degrade-path queries.
 *
 * Stores the most recent SUCCESSFUL result of a nice-to-have query so that,
 * when a subsequent run of that query times out / errors, the server can
 * serve the last good result instead of a blank fallback (e.g. `[]`).
 *
 * ── THE SAFETY INVARIANT (do not violate) ──────────────────────────────
 * Last-good must be READ only when a query TIMED OUT / errored — NEVER when
 * a query legitimately returns `[]` (rows genuinely left the result set).
 *
 * This is guaranteed by construction at the call site (see
 * `degradeOnTimeout` in api/lottery-finder.ts):
 *   - On SUCCESS  → always OVERWRITE the cache with the fresh result, even
 *                   when that result is `[]`. A legit-empty result resolves
 *                   successfully, so it overwrites last-good and is returned
 *                   directly; `readLastGood` is never consulted.
 *   - On RETRYABLE ERROR → read last-good and serve it if present, else fall
 *                   back to the existing typed fallback.
 *
 * Because a genuinely-empty result RESOLVES (it does not reject), the read
 * path is unreachable for it. This prevents resurrecting a row that was
 * legitimately removed. The cache helper itself is intentionally dumb: it
 * never decides WHEN to read — only the error branch of `degradeOnTimeout`
 * calls `readLastGood`.
 *
 * Both helpers swallow ALL errors (KV-unavailable / quota / parse): a cache
 * miss or a dead KV must degrade silently to the existing behavior, never
 * crash the request. Errors are surfaced as a `redis.error` metric only,
 * mirroring schwab.ts.
 *
 * Upstash auto-serializes JSON, so values round-trip without manual
 * stringify/parse.
 */

import { redis, safeRedis } from './redis.js';

/**
 * Read the last successfully-cached value for `key`.
 *
 * @returns the cached value on a hit, or `null` on a miss OR on any error
 *          (KV unavailable, quota, parse failure). Never throws. `safeRedis`
 *          centralizes the swallow + `redis.error` metric.
 */
export async function readLastGood<T>(key: string): Promise<T | null> {
  const value = await safeRedis<T | null>(() => redis.get<T>(key), null);
  return value ?? null;
}

/**
 * Fire-and-forget write of `value` under `key` with a `ttlSec` expiry.
 *
 * Swallows all errors (KV unavailable, quota): caching is best-effort and
 * must never throw into the request path.
 */
export async function writeLastGood<T>(
  key: string,
  value: T,
  ttlSec: number,
): Promise<void> {
  await safeRedis(async () => {
    await redis.set(key, value, { ex: ttlSec });
  }, undefined);
}
