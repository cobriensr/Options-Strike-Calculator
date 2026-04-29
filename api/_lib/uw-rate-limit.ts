/**
 * Shared outbound rate limiter for the Unusual Whales API.
 *
 * Every `uwFetch()` call passes through `acquireUWSlot()` first. This
 * gates synchronized cron bursts at minute boundaries that otherwise
 * trip UW's per-second smoothing window even when daily/per-minute
 * totals are well under the documented 120/min cap.
 *
 * Two Redis-backed counters per attempt:
 *   - per-second bucket (`uw:rl:s:{epoch_sec}`, TTL 5s)   — burst control
 *   - per-minute bucket (`uw:rl:m:{epoch_min}`, TTL 90s)  — safety net
 *
 * Behavior:
 *   - per-second cap exceeded → sleep with jitter and retry
 *     (up to MAX_WAIT_ATTEMPTS), then throw if still blocked
 *   - per-minute cap exceeded → throw immediately (waiting ~30s for the
 *     next minute would blow function timeouts)
 *   - Redis error → fail OPEN. Don't block the data pipeline if the
 *     limiter itself is unavailable. Same posture as `isRateLimited()`.
 *
 * Why this lives at the wrapper layer: see
 * `docs/superpowers/specs/uw-rate-limiter-2026-04-27.md` and the revert
 * commit `68b9c10`, which records the shape decision.
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

/**
 * Max concurrent UW requests in any 1-second window.
 *
 * Set to 3 to match the account's actual concurrency limit (confirmed by
 * Sentry 429 alerts during market hours). The original spec started at 8
 * as a guess; lowering to 3 was the resolution to the open question in
 * `docs/superpowers/specs/uw-rate-limiter-2026-04-27.md`.
 */
export const UW_PER_SECOND_CAP = 3;

/** Max UW requests in any 60-second window. Headroom under UW's 120/min. */
export const UW_PER_MINUTE_CAP = 100;

/**
 * Max retry attempts when per-second cap is hit.
 *
 * 60 × ~250ms avg = ~15s max wall-clock per call, well under the 60s
 * Vercel cron timeout. Sized to drain a 16-handler burst at 3/sec
 * (~6s) with margin even if Tier-2 jitter (`cronJitter()`) is bypassed.
 */
export const MAX_WAIT_ATTEMPTS = 60;

/** Base sleep before retry on per-second cap hit (ms). */
export const WAIT_BASE_MS = 150;

/** Random jitter added to base sleep (ms). */
export const WAIT_JITTER_MS = 100;

// ── Internal helpers ──────────────────────────────────────────

const SEC_KEY_TTL = 5;
const MIN_KEY_TTL = 90;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
 * Acquire a slot before making a UW request. Resolves when the slot is
 * granted, throws if the per-minute cap is hit or if the per-second
 * cap blocks the call past `MAX_WAIT_ATTEMPTS`.
 *
 * Callers (`uwFetch`) should let the throw propagate — the cron
 * handler's existing catch will record it; downstream metrics surface
 * the pressure.
 */
export async function acquireUWSlot(): Promise<void> {
  if (!isRedisConfigured()) return; // no-op when KV is not configured
  for (let attempt = 0; attempt < MAX_WAIT_ATTEMPTS; attempt++) {
    const nowMs = Date.now();
    const secKey = `uw:rl:s:${Math.floor(nowMs / 1000)}`;

    const secCount = await incrWithTtl(secKey, SEC_KEY_TTL);
    if (secCount === null) return; // Redis down — fail open

    if (secCount > UW_PER_SECOND_CAP) {
      metrics.increment('uw.rate_limit.wait.second');
      const wait = WAIT_BASE_MS + Math.random() * WAIT_JITTER_MS;
      await sleep(wait);
      continue;
    }

    const minKey = `uw:rl:m:${Math.floor(nowMs / 60000)}`;
    const minCount = await incrWithTtl(minKey, MIN_KEY_TTL);
    if (minCount === null) return; // Redis down between calls — fail open

    if (minCount > UW_PER_MINUTE_CAP) {
      metrics.increment('uw.rate_limit.throw.minute');
      throw new Error(
        `UW rate limiter: per-minute cap (${UW_PER_MINUTE_CAP}) exceeded`,
      );
    }

    return; // slot granted
  }

  metrics.increment('uw.rate_limit.throw.second');
  throw new Error(
    `UW rate limiter: per-second cap blocked acquisition after ${MAX_WAIT_ATTEMPTS} attempts`,
  );
}
