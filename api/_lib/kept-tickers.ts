/**
 * Per-day "kept-tickers" Redis set for the Lottery feed's MONOTONIC Q1/Q2
 * inversion-quintile suppression.
 *
 * ── WHY ────────────────────────────────────────────────────────────────
 * /api/lottery-finder suppresses chains whose ticker sits in inversion
 * quintile 1-2 (`lottery_ticker_stats.inversion_quintile`). That quintile
 * is recomputed by the detect-lottery-fires cron and can FLIP mid-session,
 * so a ticker that was shown earlier (quintile > 2) can suddenly be
 * suppressed — its chains vanish from the server feed.
 *
 * The invariant we want: once a ticker has been SHOWN (quintile > 2) at any
 * point today, it stays shown for the rest of the day even if its quintile
 * later flips into Q1/Q2. We accumulate every ever-shown ticker into a
 * per-day Redis set; the suppression predicate then also keeps any ticker
 * in that set.
 *
 * ── SAFETY ─────────────────────────────────────────────────────────────
 * Both helpers swallow ALL errors (KV-unavailable / quota): a dead KV must
 * degrade to today's pure-live suppression, never crash the request. When
 * the read returns `[]`, the predicate's `= ANY('{}'::text[])` term matches
 * nothing → exact pre-existing behavior. Errors surface as a `redis.error`
 * metric only, mirroring last-good-cache.ts / schwab.ts.
 *
 * The key is date-scoped (`lf:kept:<date>`) so the set can never leak across
 * trading days, and carries a 6h TTL as belt-and-suspenders cleanup.
 */

import { redis } from './schwab.js';
import { metrics } from './sentry.js';

/** 6 hours — comfortably covers one RTH session; date in the key is the
 * real cross-day guard, TTL is just hygiene. */
const KEPT_TTL_SEC = 6 * 3600;

function keptKey(date: string): string {
  return `lf:kept:${date}`;
}

/**
 * Read the set of tickers shown at least once today (`date`).
 *
 * @returns the set members on a hit, or `[]` on an empty set OR on any
 *          error (KV unavailable, quota). Never throws.
 */
export async function readKeptTickers(date: string): Promise<string[]> {
  try {
    return await redis.smembers(keptKey(date));
  } catch {
    metrics.increment('redis.error');
    return [];
  }
}

/**
 * Fire-and-forget: add `tickers` to today's kept-set and refresh its TTL.
 *
 * No-op on empty input (avoids a needless round-trip + an `sadd` with no
 * members, which Upstash rejects). Swallows all errors — accumulation is
 * best-effort and must never throw into the request path.
 */
export async function addKeptTickers(
  date: string,
  tickers: string[],
): Promise<void> {
  const unique = [...new Set(tickers)];
  if (unique.length === 0) return;
  try {
    const key = keptKey(date);
    await redis.sadd(key, ...(unique as [string, ...string[]]));
    await redis.expire(key, KEPT_TTL_SEC);
  } catch {
    metrics.increment('redis.error');
  }
}
