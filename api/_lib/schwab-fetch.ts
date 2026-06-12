/**
 * Authenticated Schwab API call helpers.
 *
 * Wraps token retrieval, retry-on-5xx, timeout, and metrics for the two
 * Schwab base URLs (Market Data + Trader). Used by the data endpoints
 * (quotes, intraday, yesterday) and the positions endpoint.
 *
 * Split from `api-helpers.ts` (Phase 2 of api-refactor-2026-05-02).
 * Re-exported from `api-helpers.ts` for backward compatibility.
 */

import { getAccessToken } from './schwab.js';
import { TIMEOUTS } from './constants.js';
import logger from './logger.js';
import { metrics } from './sentry.js';

const SCHWAB_BASE = 'https://api.schwabapi.com/marketdata/v1';
const SCHWAB_TRADER_BASE = 'https://api.schwabapi.com/trader/v1';

/**
 * Discriminated union for internal API call results.
 * Use `result.ok` to narrow the type instead of `'error' in result`.
 */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status: number; code?: string };

/**
 * Make an authenticated GET request to a Schwab API endpoint.
 * Handles token retrieval and error responses.
 */
async function schwabApiFetch<T>(
  base: string,
  path: string,
): Promise<ApiResult<T>> {
  const authResult = await getAccessToken();

  if ('error' in authResult) {
    metrics.tokenRefresh(false);
    const status = authResult.error.type === 'expired_refresh' ? 401 : 500;
    const code =
      authResult.error.type === 'expired_refresh'
        ? 'SCHWAB_TOKEN_EXPIRED'
        : 'SCHWAB_TOKEN_ERROR';
    return {
      ok: false,
      error: `[${code}] ${authResult.error.message}`,
      status,
    };
  }

  const endpoint = path.split('?')[0] ?? path;
  const done = metrics.schwabCall(endpoint);

  const url = `${base}${path}`;
  const MAX_RETRIES = 2;
  let res: Response | undefined;
  let lastNetworkError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${authResult.token}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(TIMEOUTS.SCHWAB_API),
      });
      lastNetworkError = undefined;
      if (res.ok || res.status < 500) break;
    } catch (err) {
      // Network-layer failure: AbortSignal.timeout firing a TimeoutError
      // (DOMException), ECONNRESET, ENOTFOUND, etc. Treat these the same
      // way we treat a 5xx — log + retry. Without this catch the throw
      // bubbles up to the cron handler, which captures it to Sentry,
      // producing one "TimeoutError" issue per timeout (issue 76 was
      // ~15 events/3hr on fetch-strike-iv calling Schwab's /chains).
      lastNetworkError = err;
      res = undefined;
    }

    if (attempt < MAX_RETRIES) {
      const errMsg =
        lastNetworkError instanceof Error
          ? lastNetworkError.message
          : undefined;
      logger.warn(
        {
          status: res?.status,
          attempt,
          endpoint,
          ...(errMsg != null ? { err: errMsg } : {}),
        },
        'Schwab transient error, retrying',
      );
      // Linear backoff with ±25% jitter so parallel callers that hit a
      // shared upstream blip don't synchronize their retries into a
      // second thundering herd. Total wait at attempt=0: 0.75-1.25s; at
      // attempt=1: 1.5-2.5s.
      const baseMs = 1000 * (attempt + 1);
      const jitterMs = baseMs * (0.75 + Math.random() * 0.5);
      await new Promise((r) => setTimeout(r, jitterMs));
    }
  }

  // All retries exhausted with a network failure (no Response at all).
  if (!res) {
    done(false);
    const errMessage =
      lastNetworkError instanceof Error
        ? lastNetworkError.message
        : String(lastNetworkError ?? 'unknown error');
    return {
      ok: false,
      error: `[SCHWAB_API_NETWORK] Schwab API network error: ${errMessage}`,
      status: 504,
    };
  }

  if (!res.ok) {
    done(false);
    const body = await res.text();
    const code =
      res.status === 401 ? 'SCHWAB_API_REJECTED' : `SCHWAB_API_${res.status}`;
    return {
      ok: false,
      error: `[${code}] Schwab API error (${res.status}): ${body}`,
      status: res.status === 401 ? 401 : res.status === 429 ? 429 : 502,
    };
  }

  done(true);
  // Node's fetch types `.json()` as Promise<unknown>; the caller's generic T
  // is the declared response contract (AUD-M34 — was implicit `any` under DOM lib).
  const data = (await res.json()) as T;
  return { ok: true, data };
}

/** Authenticated GET to the Schwab Market Data API. */
export function schwabFetch<T>(path: string): Promise<ApiResult<T>> {
  return schwabApiFetch(SCHWAB_BASE, path);
}

/** Authenticated GET to the Schwab Trader API (accounts, orders, positions). */
export function schwabTraderFetch<T>(path: string): Promise<ApiResult<T>> {
  return schwabApiFetch(SCHWAB_TRADER_BASE, path);
}
