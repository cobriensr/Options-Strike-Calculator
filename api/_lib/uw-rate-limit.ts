/**
 * Shared outbound budget guardrail for the Unusual Whales API.
 *
 * Enforces a per-minute request budget (`uw:rl:m:{epoch_min}`) as a
 * runaway guard. UW lifted its 120/min cap on 2026-08-13, so this is no
 * longer sized against a UW ceiling — see `UW_PER_MINUTE_CAP` below.
 * Every `uwFetch()` call passes through `acquireUWSlot()` before reaching
 * the concurrency semaphore.
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

import { redis } from './redis.js';
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
 * Max UW requests in any 60-second window — a RUNAWAY GUARD, not a throttle.
 *
 * History:
 *   - 100 → 115 on 2026-05-19, sized as headroom under UW's then-real
 *     120/min ceiling. Every-minute crons (fetch-strike-trade-volume,
 *     fetch-greek-flow-etf, fetch-nope, fetch-flow-alerts,
 *     enrich-lottery-outcomes) plus on-demand lottery-finder reads were
 *     burning ~95-110 calls/min at peak and tripping the self-cap ~15x/day.
 *   - 115 → 2000 on 2026-09-07. **UW lifted the 120/min cap on 2026-08-13**
 *     and gave Advanced plans unlimited daily requests on 2026-08-09.
 *     Confirmed empirically against live response headers, not just the
 *     changelog: `x-uw-req-per-minute-remaining: 1000000`,
 *     `x-uw-token-req-limit: 100000000`. Our 115 was therefore rejecting
 *     requests roughly four orders of magnitude below the real ceiling —
 *     self-inflicted data loss during exactly the peak minutes we care about.
 *
 * 2000 is ~18x the observed production peak (~110/min) — high enough that
 * legitimate bursts never trip it, low enough to still stop a runaway loop.
 * It is a REAL guard, not a decorative one: measured 2026-09-08, the app can
 * genuinely exceed it (see below), so it can and will fire on a true runaway.
 *
 * Sizing measured, not assumed. A sustained-concurrency probe against
 * `/stock/SPY/greek-exposure` found UW p50 latency of ~52ms — NOT the
 * ~0.8-1.5s this module was originally sized against. At
 * `UW_CONCURRENCY_CAP = 3` that is ~2,700 req/min of headroom, so the
 * concurrency semaphore does NOT bound us anywhere near 200/min. Anyone
 * reasoning about throughput from the old latency figure will be off by
 * more than an order of magnitude.
 *
 * Do NOT re-tighten toward 120 without re-reading the live headers — see the
 * `x-uw-*` capture in `uw-fetch.ts`, which gauges UW's self-reported budget.
 *
 * Override without a deploy via the `UW_PER_MINUTE_CAP` env var.
 */
export const UW_PER_MINUTE_CAP = 2000;

/**
 * Effective cap, read at call time so tests can vary the override without
 * re-importing the module. (On Vercel `process.env` is populated before
 * module evaluation, so this is not about serverless env timing.) A
 * non-numeric or non-positive override is ignored in favour of the default.
 */
export function getPerMinuteCap(): number {
  const raw = process.env.UW_PER_MINUTE_CAP;
  // Strict digits-only: `parseInt('5x')` would otherwise silently yield 5.
  if (raw === undefined || !/^\d+$/.test(raw)) return UW_PER_MINUTE_CAP;
  const parsed = Number.parseInt(raw, 10);
  return parsed > 0 ? parsed : UW_PER_MINUTE_CAP;
}

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

  // The INCR is already paid for; surface the count so per-minute UW call
  // volume is observable regardless of whether the guard below fires.
  metrics.uwMinuteCount(minCount);

  const cap = getPerMinuteCap();
  if (minCount > cap) {
    metrics.increment('uw.rate_limit.throw.minute');
    throw new Error(`UW rate limiter: per-minute cap (${cap}) exceeded`);
  }
}
