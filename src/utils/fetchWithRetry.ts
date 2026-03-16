/**
 * Fetch wrapper with retry logic for transient failures.
 *
 * Retries on:
 *   - Network errors (TypeError from fetch)
 *   - HTTP 502, 503, 504 (server/gateway issues)
 *
 * Does NOT retry on:
 *   - 400, 401, 403, 429 (client errors / rate limits)
 *   - AbortError (user-initiated or timeout cancellation)
 *   - Any other 4xx status
 *
 * Uses exponential backoff: 1s, 2s, 4s (for maxRetries=3).
 */

/** Status codes that indicate a transient server issue worth retrying */
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

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
