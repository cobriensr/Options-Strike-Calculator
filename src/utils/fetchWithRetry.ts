/**
 * Fetch wrapper with retry logic for transient failures.
 *
 * Retries on:
 *   - Network errors (TypeError from fetch)
 *   - HTTP 502, 504 (gateway hiccups where the server may not have done work)
 *
 * Does NOT retry on:
 *   - 503 (our API's deliberate soft-degrade signal — see RETRYABLE_STATUSES)
 *   - 400, 401, 403, 429 (client errors / rate limits)
 *   - AbortError (user-initiated or timeout cancellation)
 *   - Any other 4xx status
 *
 * Uses exponential backoff: 1s, 2s, 4s (for maxRetries=3).
 */

/**
 * Status codes fetchWithRetry auto-retries.
 *
 * 503 is intentionally EXCLUDED: a 503 from our own API is the deliberate
 * soft-degrade signal ("the server already retried via withDbRetry; back
 * off"), so the client must NOT hammer it with retries — the caller's own
 * cadence (e.g. the 30s heatmap poll) IS the retry. 502/504 are gateway
 * hiccups where the server may not have done any work, so those stay
 * retryable.
 */
const RETRYABLE_STATUSES = new Set([502, 504]);

/** 502/503/504 are transient server states the UI should treat as a soft,
 * auto-retrying degrade (distinct from RETRYABLE_STATUSES, which is the
 * subset fetchWithRetry auto-retries). */
export const TRANSIENT_HTTP_STATUSES = new Set([502, 503, 504]);
export function isTransientHttpStatus(status: number): boolean {
  return TRANSIENT_HTTP_STATUSES.has(status);
}

export interface FetchWithRetryOptions extends RequestInit {
  maxRetries?: number;
}

export async function fetchWithRetry(
  url: string,
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const { maxRetries = 2, ...fetchOptions } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, fetchOptions);

      // Don't retry client errors or non-transient server errors
      if (res.ok || !RETRYABLE_STATUSES.has(res.status)) {
        return res;
      }

      // Last attempt — return the error response as-is
      if (attempt === maxRetries) {
        return res;
      }

      // Backoff before retry: 1s, 2s, 4s...
      await sleep(1000 * 2 ** attempt);
    } catch (err) {
      // Don't retry user cancellation
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }

      // Last attempt — rethrow
      if (attempt === maxRetries) {
        throw err;
      }

      await sleep(1000 * 2 ** attempt);
    }
  }

  // Unreachable, but TypeScript needs it
  throw new Error('fetchWithRetry: exhausted retries');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
