/**
 * Unusual Whales API fetch + retry + concurrency-mapping primitives.
 *
 * `uwFetch` issues a single authenticated UW request, gating it through
 * both the per-minute rate budget (`acquireUWSlot`) and the in-flight
 * concurrency cap (`acquireConcurrencySlot`). `parseUwHttpStatus`
 * recovers the HTTP status from a `uwFetch`-thrown error message so
 * callers can branch on 4xx vs network failures. `withRetry` is a
 * UW-aware exponential backoff with distinct sleep schedules for the
 * concurrent vs per-minute 429 sub-types. `mapWithConcurrency` fans
 * work out across N workers without exceeding the UW concurrency cap.
 *
 * Split from `api-helpers.ts` (Phase 2 of api-refactor-2026-05-02).
 * Re-exported from `api-helpers.ts` for backward compatibility.
 */

import { TIMEOUTS, UW_BASE } from './constants.js';
import logger from './logger.js';
import { metrics, Sentry } from './sentry.js';
import { acquireUWSlot } from './uw-rate-limit.js';
import {
  acquireConcurrencySlot,
  releaseConcurrencySlot,
} from './uw-concurrency.js';

// ============================================================
// RETRY HELPER (for transient Neon / network failures)
// ============================================================

/**
 * Retry an async operation with exponential backoff.
 * Only retries on transient errors (timeouts, connection resets).
 * Non-transient errors (bad SQL, constraint violations) throw immediately.
 *
 * Designed for cron jobs where a single missed invocation creates data gaps.
 * Interactive endpoints should NOT use this — users want fast failure.
 */
/**
 * Classify a thrown error message and return the backoff in ms before
 * the next retry, or `null` if the error is not retryable.
 *
 * UW returns two distinct 429 sub-types whose right-sized backoffs
 * differ by ~20×:
 *
 *   - `concurrent` 429 — UW's concurrency cap (≤3 in-flight). Clears
 *     in ~1 s as in-flight requests drain. Short jittered backoff.
 *   - per-minute 429 (`120 in 60 seconds`) — minute window has to roll
 *     before any retry can succeed. Needs 5–10 s.
 *
 * Treating both with the same 1s/2s exponential is why per-minute
 * 429s exhausted all retries before the spec-compliant fix shipped.
 *
 * Network errors and 5xx upstream failures keep the existing
 * exponential `1000 × (attempt + 1)`.
 */
function classifyRetryDelay(msg: string, attempt: number): number | null {
  // 429 — distinguish concurrency vs per-minute window
  if (/UW API 429|\b429\b/.test(msg)) {
    if (/concurrent/i.test(msg)) {
      return 250 + Math.random() * 250; // 250–500 ms jittered
    }
    if (/in 60 seconds|per minute|rate limit of/i.test(msg)) {
      return 5000 + Math.random() * 5000; // 5–10 s
    }
    // Generic 429 — fall through to default exponential
    return 1000 * (attempt + 1);
  }

  if (/50[234]/.test(msg)) {
    return 1000 * (attempt + 1);
  }

  if (
    /timeout|ECONNREFUSED|ECONNRESET|fetch failed|socket hang up/i.test(msg)
  ) {
    return 1000 * (attempt + 1);
  }

  return null; // not retryable
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number = 2,
): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt === retries;
      const msg = err instanceof Error ? err.message : '';
      const delayMs = classifyRetryDelay(msg, attempt);
      if (isLast || delayMs === null) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('unreachable');
}

// ============================================================
// CONCURRENCY LIMITER (for fan-out crons)
// ============================================================

/**
 * Map an array of items through `worker` with at most `limit` calls
 * in flight at once. Output order matches input order regardless of
 * resolution order.
 *
 * Use this whenever a cron fans out to >3 UW requests in parallel —
 * the UW plan caps concurrent in-flight requests at 3, so a naked
 * `Promise.all` over a 13-ticker list 429s the last 10. The shared
 * `acquireUWSlot()` is a *rate* limiter (per-second / per-minute
 * INCR), not a concurrency cap, so it can't catch this.
 *
 * Workers pull from a shared cursor, so they invoke `worker` in
 * input-index order (0, 1, 2 first, then 3, 4, 5 as each slot frees).
 * That preserves call order for tests that rely on `mockResolvedValueOnce`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runner = async (): Promise<void> => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await worker(items[idx]!, idx);
    }
  };
  const runnerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: runnerCount }, runner));
  return results;
}

// ============================================================
// UNUSUAL WHALES API HELPERS
// ============================================================

/**
 * Fetch JSON from the Unusual Whales API.
 *
 * Handles auth header, timeout, non-OK responses, and returns the
 * parsed `body.data` array. For endpoints with nested data structures
 * (e.g., net-flow/expiry returns `data[0].data`), use the `extract`
 * parameter to customize the extraction.
 *
 * @param apiKey - UW API key
 * @param path - path after UW_BASE (e.g., "/market/SPY/etf-tide")
 * @param extract - optional function to extract data from response body
 */
export async function uwFetch<T>(
  apiKey: string,
  path: string,
  extract?: (body: Record<string, unknown>) => T[],
): Promise<T[]> {
  // Two-stage gating:
  //   acquireUWSlot()        → per-minute budget (cumulative quota guard)
  //   acquireConcurrencySlot → in-flight concurrency cap (UW's actual cap)
  // The semaphore must release on BOTH success and failure paths so a
  // throwing fetch doesn't permanently consume a slot.
  await acquireUWSlot();
  const slotId = await acquireConcurrencySlot();
  try {
    const url = path.startsWith('http') ? path : `${UW_BASE}${path}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(TIMEOUTS.UW_API),
    });

    if (!res.ok) {
      const text = await res
        .text()
        .catch((e) => `[parse error: ${(e as Error).message}]`);

      // BE-CRON-002 follow-up: surface UW rate-limit hits to Sentry as a
      // metric + scoped warning so we see budget pressure the moment it
      // starts, instead of waiting for data to silently thin out. Endpoint
      // is extracted with the query string stripped so identical routes
      // group together in the metric.
      if (res.status === 429) {
        const endpoint = path.startsWith('http')
          ? (() => {
              try {
                return new URL(path).pathname;
              } catch {
                return path;
              }
            })()
          : (path.split('?')[0] ?? path);
        const retryAfter = res.headers?.get?.('retry-after') ?? null;
        metrics.uwRateLimit(endpoint, retryAfter);
      }

      throw new Error(`UW API ${res.status}: ${text.slice(0, 200)}`);
    }

    const body = await res.json();
    if (extract) return extract(body);
    if (body.data === undefined) {
      logger.warn(
        { keys: Object.keys(body as Record<string, unknown>) },
        'uwFetch: response.data missing',
      );
      Sentry.captureMessage('uwFetch: response.data missing', 'warning');
      return [];
    }
    return body.data ?? [];
  } finally {
    await releaseConcurrencySlot(slotId);
  }
}

/**
 * Extract the HTTP status from a `uwFetch`-thrown error message.
 * `uwFetch` throws `new Error("UW API <status>: <body>")` on non-OK
 * responses; this helper reverses that format so callers can distinguish
 * HTTP-level failures from network/timeout/abort errors when translating
 * the throw into a discriminated-union return shape.
 *
 * Returns `null` for messages that don't match the prefix (network errors,
 * timeouts, etc.) so the caller can fall through to its default error path.
 */
export function parseUwHttpStatus(message: string): number | null {
  const prefix = 'UW API ';
  if (!message.startsWith(prefix)) return null;
  const tail = message.slice(prefix.length);
  const colonIdx = tail.indexOf(':');
  if (colonIdx === -1) return null;
  const n = Number.parseInt(tail.slice(0, colonIdx), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Round a Date to the nearest 5-minute boundary (floor).
 *
 * Used by all flow/GEX crons to sample intraday ticks at consistent
 * 5-minute intervals. Returns a new Date — does not mutate input.
 */
export function roundTo5Min(dt: Date): Date {
  const rounded = new Date(dt);
  const minutes = rounded.getMinutes();
  rounded.setMinutes(minutes - (minutes % 5), 0, 0);
  return rounded;
}
