/**
 * Shared outbound budget guardrail for the Unusual Whales API.
 *
 * Enforces a per-minute request budget (`uw:rl:m:{epoch_min}`) under
 * UW's documented 120/min cap. Every `uwFetch()` call passes through
 * `acquireUWSlot()` before reaching the concurrency semaphore.
 *
 * Behavior:
 *   - per-minute cap exceeded → throw immediately (waiting ~30s for the
 *     next minute would blow function timeouts)
 *   - Redis error → fail OPEN. Don't block the data pipeline if the
 *     limiter itself is unavailable.
 *
 * History: this module previously enforced a per-SECOND cap of 3 to
 * approximate UW's concurrency limit, but a fixed-window rate limiter
 * is the wrong shape for a concurrency cap (allows 2× the cap in flight
 * at second boundaries when request latency exceeds 1 s). The per-second
 * logic was removed when the concurrency semaphore in `uw-concurrency.ts`
 * was introduced. See
 * `docs/superpowers/specs/uw-concurrency-semaphore-2026-04-30.md` for
 * the corrective design and the prior
 * `docs/superpowers/specs/uw-rate-limiter-2026-04-27.md` for context.
 */

import { redis } from './schwab.js';
import { metrics, Sentry } from './sentry.js';
import logger from './logger.js';

/**
 * The limiter is a no-op when no KV REST URL is configured. Test
 * environments and local dev without Upstash linkage don't have these
 * env vars set; production and preview deployments do. Skipping cleanly
 * here keeps existing fetch-mocked cron tests from accidentally
 * consuming their first `fetch` call on the Upstash REST endpoint.
 */
function isRedisConfigured(): boolean {
  return Boolean(
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL,
  );
}

// ── Tuning ────────────────────────────────────────────────────

/** Max UW requests in any 60-second window. Headroom under UW's 120/min. */
export const UW_PER_MINUTE_CAP = 100;

// ── Internal helpers ──────────────────────────────────────────

const MIN_KEY_TTL = 90;

/**
 * INCR a counter key with TTL. Returns the post-increment count, or
 * `null` if Redis errored — caller should fail open in that case.
 */
async function incrWithTtl(
  key: string,
  ttlSec: number,
): Promise<number | null> {
  try {
    const pipe = redis.pipeline();
    pipe.incr(key);
    pipe.expire(key, ttlSec);
    const results = await pipe.exec();
    const count = results[0] as number;
    return typeof count === 'number' ? count : null;
  } catch (err) {
    logger.warn({ err, key }, 'uw-rate-limit: Redis call failed; failing open');
    metrics.increment('uw.rate_limit.redis_error');
    Sentry.captureException(err);
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────

/**
 * Charge one unit against the per-minute UW request budget. Resolves
 * when within budget, throws when the per-minute cap has been hit.
 *
 * Concurrency enforcement lives in `uw-concurrency.ts` — this function
 * is purely a cumulative-quota guard and intentionally does not block
 * waiting for the next minute window (that would blow function timeouts).
 *
 * Callers (`uwFetch`) should let the throw propagate — the cron
 * handler's existing catch will record it; downstream metrics surface
 * the pressure.
 */
export async function acquireUWSlot(): Promise<void> {
  if (!isRedisConfigured()) return; // no-op when KV is not configured

  const nowMs = Date.now();
  const minKey = `uw:rl:m:${Math.floor(nowMs / 60000)}`;
  const minCount = await incrWithTtl(minKey, MIN_KEY_TTL);
  if (minCount === null) return; // Redis down — fail open

  if (minCount > UW_PER_MINUTE_CAP) {
    metrics.increment('uw.rate_limit.throw.minute');
    throw new Error(
      `UW rate limiter: per-minute cap (${UW_PER_MINUTE_CAP}) exceeded`,
    );
  }
}
