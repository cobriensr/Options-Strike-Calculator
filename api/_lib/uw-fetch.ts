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
 * A non-2xx answer from UW. The message keeps the historical
 * `UW API <status>: <body, first 200 chars>` text that `parseUwHttpStatus` and
 * `classifyRetryDelay` match on; `status`, `endpoint` (a template from
 * `uwEndpointTemplate`) and `retryAfter` (the raw `retry-after` header) carry
 * what `withRetry` needs to report a 429 it gave up on.
 *
 * `name` stays `Error` (V8 leaves a subclass constructor's frame off the
 * stack by itself), so Sentry groups these exactly as it grouped the plain
 * `Error` thrown before.
 */
export class UwHttpError extends Error {
  readonly status: number;
  readonly endpoint: string;
  readonly retryAfter: string | null;

  constructor(
    status: number,
    endpoint: string,
    body: string,
    retryAfter: string | null,
  ) {
    super(`UW API ${status}: ${body.slice(0, 200)}`);
    this.status = status;
    this.endpoint = endpoint;
    this.retryAfter = retryAfter;
  }
}

// A fixed part of a UW path is a lowercase word (`greek-flow`, `etf-tide`,
// `net_prem`); a variable part is a ticker, option symbol, futures contract,
// expiry or candle size, none of which is all lowercase letters.
const FIXED_PATH_SEGMENT = /^[a-z_-]+$/;
const ISO_DATE_SEGMENT = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Collapse a UW path to a template, for use as a metric attribute or a tag.
 * The query string is dropped, an ISO date segment becomes `{date}`, and every
 * segment that is not a lowercase word becomes `{id}`, so
 * `/stock/SPY/greek-flow?date=2026-11-13` is `/stock/{id}/greek-flow`. The set
 * of values is the set of UW route shapes, not tickers x dates x contracts. A
 * full URL keeps only its path, without the `/api` prefix, and one that does
 * not parse is `other`.
 */
export function uwEndpointTemplate(path: string): string {
  let pathname: string;
  if (path.startsWith('http')) {
    try {
      pathname = new URL(path).pathname.replace(/^\/api(?=\/|$)/, '');
    } catch {
      return 'other';
    }
  } else {
    pathname = path.split(/[?#]/, 1)[0] ?? '';
  }
  return pathname
    .split('/')
    .map((segment) => {
      if (segment === '' || FIXED_PATH_SEGMENT.test(segment)) return segment;
      return ISO_DATE_SEGMENT.test(segment) ? '{date}' : '{id}';
    })
    .join('/');
}

/** Report a UW 429 that `withRetry` is about to throw: its retries ran out. */
function reportRetriesExhausted(err: unknown): void {
  if (err instanceof UwHttpError && err.status === 429) {
    metrics.uwRateLimitExhausted(err.endpoint, err.retryAfter);
  }
}

/**
 * GEXBot's `Retry-After` in ms, when its error carries one. Read by shape, not
 * by class, so this module does not import the GEXBot client.
 */
function retryAfterMsOf(err: unknown): number | null {
  const ms = (err as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/**
 * The longest GEXBot `Retry-After` a retry will wait out. A cron's worst case
 * for one failing fetch is about 10.5 s (`GEXBOT_TIMEOUT_MS` in
 * gexbot-client.ts); two waits of at most this plus jitter keep a 429 under it.
 * A longer ask is not waited for: the next tick re-fetches.
 */
const GEXBOT_429_MAX_WAIT_MS = 3000;

/**
 * Backoff before retrying a GEXBot 429, or `null` when `Retry-After` asks for
 * longer than `GEXBOT_429_MAX_WAIT_MS`. The vendor documents a per-account
 * short-window limit (a 429 with `Retry-After`) and daily/monthly pool quotas
 * (a 429 with none, lasting until midnight ET); the one burst seen was
 * transient. So the wait is `1000 × (attempt + 1)` (1 s, then 2 s), raised to
 * `Retry-After` when sent, plus up to 250 ms of jitter so a wave of retries
 * does not land in the same second. A quota 429 gets the same two retries and
 * then fails, and the next tick re-fetches.
 */
function gexbot429Delay(err: unknown, attempt: number): number | null {
  const retryAfterMs = retryAfterMsOf(err);
  if (retryAfterMs !== null && retryAfterMs > GEXBOT_429_MAX_WAIT_MS) {
    return null;
  }
  return (
    Math.max(retryAfterMs ?? 0, 1000 * (attempt + 1)) + Math.random() * 250
  );
}

/**
 * Classify a thrown error and return the backoff in ms before the next retry,
 * or `null` if the error is not retryable.
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
 * Network errors and 5xx upstream failures (500/502/503/504) keep the
 * existing exponential `1000 × (attempt + 1)`.
 *
 * GEXBot: a `GEXBot 429` retries with backoff (`gexbot429Delay`), at most
 * twice. It may be the vendor's short-window limit, which a short wait clears,
 * or a pool quota, which it does not; the crons' `gexbot.retry_after_ms` tag
 * tells the two apart afterwards. `GEXBot 500 … null or zero length` (no
 * snapshot exists yet) is never retried (`null`). Other GEXBot 5xx still
 * retry. UW and every other caller are unaffected: both checks are anchored to
 * the `GEXBot` message prefix. The EOD report route is not here: it does not go
 * through `withRetry`, and it treats a 429 as a quota and stops.
 */
function classifyRetryDelay(err: unknown, attempt: number): number | null {
  const msg = err instanceof Error ? err.message : '';
  // GEXBot failures, checked before the generic branches below (withRetry is
  // shared across UW, GEXBot and others):
  //  - `GEXBot 429`: retried with backoff; see gexbot429Delay.
  //  - `GEXBot 500 ... null or zero length`: the orderflow route's answer
  //    when no snapshot exists yet. Deterministic, not a blip.
  if (/^GEXBot 429\b/.test(msg)) return gexbot429Delay(err, attempt);
  if (/^GEXBot 500\b.*null or zero length/s.test(msg)) return null;

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

  // Match a genuine upstream 5xx (500/502/503/504) only when it is the LEADING
  // status token after a service prefix — `UW API 500: …`, `GEXBot 503 …`
  // (withRetry is a generic helper shared across UW + GexBot + others). The
  // required ≥1 leading alphabetic word excludes a bare `502 Bad Gateway`, and
  // because the prefix run is letters-only it can't skip a non-5xx status to a
  // `50x` buried later in the body (e.g. `UW API 400: …500…`). (AUD-L2)
  // 500 is included because UW 500 incidents are usually ~1 s blips that hit
  // several crons at once — one backoff-and-retry rides them out.
  if (/^(?:[A-Za-z]+ )+50[0234]\b/.test(msg)) {
    return 1000 * (attempt + 1);
  }

  if (
    /timeout|ECONNREFUSED|ECONNRESET|fetch failed|socket hang up/i.test(msg)
  ) {
    return 1000 * (attempt + 1);
  }

  return null; // not retryable
}

/**
 * Retry an async operation with exponential backoff.
 * Only retries on transient errors (timeouts, connection resets).
 * Non-transient errors (bad SQL, constraint violations) throw immediately.
 *
 * Designed for cron jobs where a single missed invocation creates data gaps.
 * Interactive endpoints should NOT use this — users want fast failure.
 *
 * When it gives up on a UW 429 it reports that one failure to Sentry
 * (`metrics.uwRateLimitExhausted`) before rethrowing; a 429 a retry clears
 * is only counted by `uwFetch`.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number = 2,
): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt === retries;
      const delayMs = classifyRetryDelay(err, attempt);
      if (isLast || delayMs === null) {
        reportRetriesExhausted(err);
        throw err;
      }
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
 * Fraction of successful UW responses whose budget headers are gauged.
 * The headers are identical across calls in the same minute, so a low
 * sample is enough to trend the limits without flooding Sentry.
 */
const UW_BUDGET_SAMPLE_RATE = 0.01;

/**
 * Emit a gauge below this many remaining per-minute requests regardless of
 * sampling. Sized to catch UW reinstating a small cap (the old ceiling was
 * 120/min); at today's reported 1,000,000 it never fires.
 */
const UW_BUDGET_ALERT_REMAINING = 500;

function readIntHeader(res: Response, name: string): number | null {
  const raw = res.headers?.get?.(name);
  if (raw == null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Record UW's self-reported request budget from `x-uw-*` response headers.
 * UW exposes no usage endpoint, so these headers are the only way to know
 * the real limits — and the only way to catch UW changing them under us.
 *
 * Called before the non-OK branch so a 429 still reports its budget: UW omits
 * these headers on 401/403 but DOES send them on 429, which is precisely the
 * moment we need them. `force` bypasses sampling for that case.
 *
 * Never throws: observability must not be able to fail a data fetch.
 */
function recordUWBudget(res: Response, force = false): void {
  try {
    const minuteRemaining = readIntHeader(res, 'x-uw-req-per-minute-remaining');
    const low =
      minuteRemaining !== null && minuteRemaining < UW_BUDGET_ALERT_REMAINING;
    const sampled = Math.random() < UW_BUDGET_SAMPLE_RATE;
    if (!force && !sampled && !low) return;

    metrics.uwBudget({
      minuteRemaining,
      dailyLimit: readIntHeader(res, 'x-uw-token-req-limit'),
      dailyUsed: readIntHeader(res, 'x-uw-daily-req-count'),
    });
  } catch {
    // Deliberately swallowed — a metrics failure must never break a fetch.
  }
}

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

    // Before the non-OK branch below throws — a 429 carries the budget
    // headers and is exactly when we want them recorded.
    recordUWBudget(res, res.status === 429);

    if (!res.ok) {
      const text = await res
        .text()
        .catch((e) => `[parse error: ${(e as Error).message}]`);

      // BE-CRON-002 follow-up: count every UW rate-limit hit so budget
      // pressure shows the moment it starts, instead of data silently
      // thinning out. Counting is all a 429 does here: whether it is worth a
      // Sentry event depends on whether the retry loop clears it, which only
      // `withRetry` knows (it reports the one it gives up on, from the
      // endpoint and retry-after this error carries). The endpoint is a path
      // template, so the metric's cardinality is the route list.
      const endpoint = uwEndpointTemplate(path);
      const retryAfter = res.headers?.get?.('retry-after') ?? null;
      if (res.status === 429) metrics.uwRateLimit(endpoint);

      throw new UwHttpError(res.status, endpoint, text, retryAfter);
    }

    // Node types `.json()` as Promise<unknown> (was implicit `any` under DOM
    // lib). UW responses are JSON objects; narrow to a record so `.data` and
    // the extractor see a typed shape (AUD-M34).
    const body = (await res.json()) as Record<string, unknown>;
    if (extract) return extract(body);
    if (body.data === undefined) {
      logger.warn(
        { keys: Object.keys(body) },
        'uwFetch: response.data missing',
      );
      Sentry.captureMessage('uwFetch: response.data missing', 'warning');
      return [];
    }
    return (body.data ?? []) as T[];
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
