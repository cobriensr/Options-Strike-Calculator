/**
 * Distributed counting semaphore for the Unusual Whales API.
 *
 * Enforces UW's actual cap: ≤ N requests in-flight at any moment, regardless
 * of dispatch timing. This is fundamentally different from a per-second rate
 * limiter, which can allow 2× the cap in flight at second boundaries when
 * UW request latency exceeds 1 s. See
 * `docs/superpowers/specs/uw-concurrency-semaphore-2026-04-30.md` for the
 * full design rationale and the failure case that motivated this module.
 *
 * Implementation: single Redis ZSET (`uw:cc`) where members are slot UUIDs
 * and scores are lease expiry timestamps (ms since epoch). Each acquire
 * lazily reaps expired leases before checking cardinality, so leaks from
 * crashed function instances self-heal in `LEASE_MS`.
 *
 * Acquire is atomic via a Redis-side Lua script. Release is a `ZREM`.
 *
 * Behavior:
 *   - cap free: slot granted immediately
 *   - cap saturated: sleep with jitter and retry up to MAX_ACQUIRE_ATTEMPTS
 *   - cap sustained: throw after attempts exhausted (cron handler logs)
 *   - Redis unavailable: fail OPEN (matches `acquireUWSlot()` posture —
 *     don't block the data pipeline if the limiter itself is down)
 *
 * Security note: the Lua source is a static `const` string. All inputs are
 * passed via `ARGV[]` — Redis treats these as opaque string values, never
 * as Lua source. All ARGV values are server-generated (UUID, Date.now(),
 * hardcoded constants). There is no path from user input to the Lua
 * runtime. See review notes in the spec doc above. Future maintainers:
 * NEVER interpolate runtime values into ACQUIRE_LUA. If you need new
 * behavior, add another ARGV slot.
 */

import { redis } from './redis.js';
import { metrics, Sentry } from './sentry.js';
import logger from './logger.js';

// ── Tuning ──────────────────────────────────────────────────────

/**
 * Max in-flight UW requests at any moment. Matches the UW account
 * concurrency cap confirmed by 429 body `"3 concurrent requests"`.
 *
 * Re-probed 2026-09-08 and the cap still exists — UW still returns
 * "You have exceeded 3 concurrent requests, the maximum allowed for your
 * current plan". But enforcement is soft, not a hard gate: sustained 5
 * in-flight drew 0% 429s, 8 drew 1.2%, 12 drew 3.8%. Raising this above 3
 * would buy real throughput (N=5 ≈ +71%) and `withRetry` already absorbs
 * concurrent-429s with a 250-500 ms jittered backoff — but 3 is the limit
 * UW *states* for this plan, so going above it is a deliberate decision to
 * lean on lax enforcement, not a free win. Left at 3 pending that call.
 */
export const UW_CONCURRENCY_CAP = 3;

/**
 * Lease TTL for an acquired slot (ms). Must exceed the longest
 * realistic UW request. NOTE: the "typical 0.8–1.5 s" figure this was
 * originally sized against is stale — a sustained probe on 2026-09-08
 * measured p50 ~52 ms on `/stock/SPY/greek-exposure`. 30 s still gives
 * ample margin (and must stay well above p99 for slow endpoints), but do
 * NOT derive throughput ceilings from the old latency number: at
 * `UW_CONCURRENCY_CAP = 3` real headroom is ~2,700 req/min, not ~200.
 */
export const LEASE_MS = 30_000;

/**
 * Max retry attempts when cap is saturated.
 *
 * 60 × ~250 ms ≈ 15 s wall-clock max, well under the 60 s Vercel cron
 * timeout and the 300 s default function timeout.
 */
export const MAX_ACQUIRE_ATTEMPTS = 60;

/** Base sleep before retry on cap-saturation (ms). */
export const WAIT_BASE_MS = 250;

/** Random jitter added to base sleep (ms). Prevents thundering herd. */
export const WAIT_JITTER_MS = 250;

// ── Internal ────────────────────────────────────────────────────

const KEY = 'uw:cc';

function isRedisConfigured(): boolean {
  return Boolean(
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Atomic acquire script — STATIC. Do not interpolate runtime values
 * into this string. All inputs are passed via ARGV, where Redis treats
 * them as opaque strings (no Lua-source interpretation).
 *
 *   1. Reap expired leases (score ≤ now).
 *   2. If current cardinality is at or above cap, return [0, current].
 *   3. Otherwise add this slot with score = expiresAt and return [1, current+1].
 *
 * Returning post-add cardinality lets the caller emit an `in_use` gauge
 * without an extra round trip.
 *
 * KEYS[1] = "uw:cc"
 * ARGV[1] = slotId (UUID)
 * ARGV[2] = now (ms)
 * ARGV[3] = expiresAt (ms)
 * ARGV[4] = cap
 *
 * Returns: [granted (0|1), inUse (number)]
 */
const ACQUIRE_LUA = `
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[2])
  local current = redis.call('ZCARD', KEYS[1])
  if current >= tonumber(ARGV[4]) then
    return {0, current}
  end
  redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
  return {1, current + 1}
`;

// ── Public API ──────────────────────────────────────────────────

/**
 * Acquire a concurrency slot before making a UW request. Resolves with
 * the slot ID (caller must pass to `releaseConcurrencySlot`). Throws if
 * the cap stays saturated past `MAX_ACQUIRE_ATTEMPTS`.
 *
 * Returns an empty string when Redis is not configured — caller treats
 * that as "fail open" and proceeds without limiting. Test environments
 * exercise this path.
 */
export async function acquireConcurrencySlot(): Promise<string> {
  if (!isRedisConfigured()) return '';

  const slotId = crypto.randomUUID();
  const acquireStart = Date.now();

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    const now = Date.now();
    const expiresAt = now + LEASE_MS;

    let result: [number, number] | null;
    try {
      result = (await redis.eval(
        ACQUIRE_LUA,
        [KEY],
        [slotId, String(now), String(expiresAt), String(UW_CONCURRENCY_CAP)],
      )) as [number, number] | null;
    } catch (err) {
      logger.warn({ err }, 'uw-concurrency: Redis EVAL failed; failing open');
      metrics.increment('uw.concurrency.redis_error');
      Sentry.captureException(err);
      return ''; // fail open
    }

    if (!result) return ''; // fail open on null result

    const [granted, inUse] = result;
    Sentry.metrics.distribution('uw.concurrency.in_use', inUse);

    if (granted === 1) {
      const waitMs = Date.now() - acquireStart;
      Sentry.metrics.distribution('uw.concurrency.wait_ms', waitMs);
      return slotId;
    }

    metrics.increment('uw.concurrency.wait');
    await sleep(WAIT_BASE_MS + Math.random() * WAIT_JITTER_MS);
  }

  metrics.increment('uw.concurrency.timeout');
  throw new Error(
    `UW concurrency semaphore: cap (${UW_CONCURRENCY_CAP}) saturated for ${MAX_ACQUIRE_ATTEMPTS} attempts`,
  );
}

/**
 * Release a previously acquired slot. Best-effort — if Redis is down,
 * the lease will expire on its own in `LEASE_MS`. Always safe to call;
 * passing an empty string (the no-op acquire return) is a no-op.
 */
export async function releaseConcurrencySlot(slotId: string): Promise<void> {
  if (!slotId) return;
  if (!isRedisConfigured()) return;
  try {
    await redis.zrem(KEY, slotId);
  } catch (err) {
    // Lease will auto-expire; don't block the response on a release failure.
    logger.warn({ err }, 'uw-concurrency: Redis ZREM failed on release');
    metrics.increment('uw.concurrency.release_error');
  }
}
