/**
 * The two UW 429 limits, told apart by the body text in the error message
 * (`UW API 429: <body, first 200 chars>`). One definition, read by two
 * callers that must agree on what a message means:
 *
 *   - `withRetry`'s backoff (`uw-fetch.ts`, `classifyRetryDelay`), through the
 *     two patterns below;
 *   - the Sentry fingerprint (`sentry.ts`, `beforeSend`), through `uw429Kind`.
 *
 * A leaf module with no imports: `uw-fetch.ts` imports `sentry.ts`, so the
 * shared text cannot live in `uw-fetch.ts` without a cycle.
 */

/**
 * UW's concurrency cap (3 requests in flight across the account). The body
 * `withRetry`'s backoff matches: "You have exceeded 3 concurrent requests, the
 * maximum allowed for your current plan".
 */
export const UW_CONCURRENT_BODY = /concurrent/i;

/**
 * The per-minute window: "You have hit the rate limit of 120 in 60 seconds".
 */
export const UW_PER_MINUTE_BODY = /in 60 seconds|per minute|rate limit of/i;

/**
 * UW's current wording for the same concurrency cap: "Too many requests in
 * flight. Your account can have 3 API requests running at a time across all of
 * its API tokens..." (Sentry issues SENTRY-EMERALD-DESERT-7Y and G6). It has
 * no "concurrent" in it, so `UW_CONCURRENT_BODY` does not match it. The
 * fingerprint counts it as a concurrency 429; the retry backoff does not test
 * it, so its retry timing is unchanged (a spec open question).
 */
const UW_IN_FLIGHT_BODY = /in flight/i;

export type Uw429Kind = 'concurrency' | 'per-minute' | 'other';

/**
 * The sub-type of a UW 429 message: `concurrency`, `per-minute`, or `other`
 * (an empty body, a bare "Too Many Requests", a daily limit). Concurrency is
 * tested first, the order `withRetry` has always used.
 */
export function uw429Kind(message: string): Uw429Kind {
  if (UW_CONCURRENT_BODY.test(message) || UW_IN_FLIGHT_BODY.test(message)) {
    return 'concurrency';
  }
  if (UW_PER_MINUTE_BODY.test(message)) return 'per-minute';
  return 'other';
}
