/**
 * Market-data facade + Schwab Trader API helper.
 *
 * `schwabFetch<T>` keeps its historical signature and ApiResult
 * envelope, but no longer calls Schwab's Market Data API for covered
 * paths: it dispatches by path prefix to the UW + Theta-sidecar
 * adapters in `market-data-adapters.ts`, which assemble byte-compatible
 * Schwab response shapes (Phase 2 of schwab-replacement-2026-08-16).
 * Callers are untouched — same paths, same shapes, same `[SCHWAB_*]`
 * error strings and 401/429/502/504 status mapping.
 *
 * Passthrough for facade gaps (readiness-loose-ends-2026-08-18, phase
 * G): when an adapter reports `501 SOURCE_UNAVAILABLE` (NYSE breadth
 * internals `$TICK/$TRIN/$ADD/$VOLD`, or any path with no adapter at
 * all) AND Schwab is configured (`SCHWAB_CLIENT_ID` +
 * `SCHWAB_CLIENT_SECRET` both set), the request falls through to the
 * real Schwab Market Data API via the legacy `schwabApiFetch` path —
 * OAuth token machinery, retries, timeout, metrics and `[SCHWAB_*]`
 * error strings included. Unconfigured deployments see the unchanged
 * 501. Configured-but-not-yet-connected deployments see the token
 * envelope (`401 SCHWAB_TOKEN_EXPIRED` / `500 SCHWAB_TOKEN_ERROR`,
 * with `code` set so consumers can skip quietly). Transient adapter
 * failures (UW 5xx, 429, …) are NOT passed through — the facade stays
 * primary and predictable; only the explicit no-source code triggers
 * the passthrough.
 *
 * `schwabTraderFetch<T>` (positions) is the one surface that is always
 * a real Schwab call — brokerage positions are inherently Schwab — and
 * shares the OAuth token machinery, retry-on-5xx, timeout, and metrics.
 *
 * Split from `api-helpers.ts` (Phase 2 of api-refactor-2026-05-02).
 * Re-exported from `api-helpers.ts` for backward compatibility.
 */

import { getAccessToken } from './schwab.js';
import { TIMEOUTS } from './constants.js';
import logger from './logger.js';
import { metrics } from './sentry.js';
import {
  chainAdapter,
  historyAdapter,
  moversAdapter,
  quotesAdapter,
  sourceUnavailable,
} from './market-data-adapters.js';

const SCHWAB_TRADER_BASE = 'https://api.schwabapi.com/trader/v1';
const SCHWAB_MARKET_BASE = 'https://api.schwabapi.com/marketdata/v1';

/**
 * Discriminated union for internal API call results.
 * Use `result.ok` to narrow the type instead of `'error' in result`.
 */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status: number; code?: string };

/**
 * Cheap config gate for the Market Data passthrough: both Schwab OAuth
 * env vars present and non-empty. Reads `process.env` directly (no
 * validated-env cache) so it is a pure per-call check; the token
 * machinery in `schwab.ts` re-validates via `requireEnvGroup('schwab')`
 * before any real call. Kept private here to avoid coupling to
 * `schwab.ts` — unify with an `isSchwabConfigured()` there later.
 */
function hasSchwabConfig(): boolean {
  return (
    Boolean(process.env.SCHWAB_CLIENT_ID) &&
    Boolean(process.env.SCHWAB_CLIENT_SECRET)
  );
}

/** The facade's explicit "no source for this path/symbol" marker. */
function isSourceUnavailable(result: ApiResult<unknown>): boolean {
  return (
    !result.ok &&
    (result.status === 501 || result.code === 'SOURCE_UNAVAILABLE')
  );
}

/**
 * Module-level latch so the "passthrough active" notice lands once per
 * process (cold start), not once per call — the cron that hits the
 * gap runs every minute across four symbols.
 */
let passthroughAnnounced = false;

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
    // `code` is set so facade consumers can tell "Schwab configured but
    // OAuth not completed" apart from a genuine upstream failure and
    // skip quietly (fetch-market-internals) — same string prefix as
    // before, so the `[SCHWAB_TOKEN_*]` error contract is unchanged.
    return {
      ok: false,
      error: `[${code}] ${authResult.error.message}`,
      status,
      code,
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

/**
 * Market-data GET in the legacy Schwab path dialect.
 *
 * Dispatches on the path prefix to the UW/Theta-sidecar adapters:
 *   /chains       → chainAdapter
 *   /pricehistory → historyAdapter
 *   /quotes       → quotesAdapter
 *   /movers       → moversAdapter
 *   anything else → 501 SOURCE_UNAVAILABLE (consumers are fail-open)
 *
 * When the adapter result is 501 SOURCE_UNAVAILABLE and Schwab is
 * configured, the call passes through to the real Schwab Market Data
 * API (`SCHWAB_MARKET_BASE` + path). Only the explicit no-source code
 * triggers this — transient adapter failures are returned as-is.
 *
 * Never throws — always resolves to an ApiResult, exactly like the
 * legacy Schwab implementation.
 */
export async function schwabFetch<T>(path: string): Promise<ApiResult<T>> {
  const endpoint = path.split('?')[0] ?? path;
  const done = metrics.schwabCall(endpoint);

  let result: ApiResult<unknown>;
  if (endpoint.startsWith('/chains')) {
    result = await chainAdapter(path);
  } else if (endpoint.startsWith('/pricehistory')) {
    result = await historyAdapter(path);
  } else if (endpoint.startsWith('/quotes')) {
    result = await quotesAdapter(path);
  } else if (endpoint.startsWith('/movers')) {
    result = await moversAdapter(path);
  } else {
    result = sourceUnavailable(path);
  }

  if (isSourceUnavailable(result) && hasSchwabConfig()) {
    if (!passthroughAnnounced) {
      passthroughAnnounced = true;
      logger.info(
        { endpoint },
        'schwabFetch: Schwab Market Data passthrough active for facade gaps (SOURCE_UNAVAILABLE → api.schwabapi.com)',
      );
    }
    // schwabApiFetch owns its own schwabCall metric + done() for the
    // real call, so the facade-side timer is dropped here rather than
    // double-counting the endpoint.
    return schwabApiFetch<T>(SCHWAB_MARKET_BASE, path);
  }

  done(result.ok);
  return result as ApiResult<T>;
}

/** Authenticated GET to the Schwab Trader API (accounts, orders, positions). */
export function schwabTraderFetch<T>(path: string): Promise<ApiResult<T>> {
  return schwabApiFetch(SCHWAB_TRADER_BASE, path);
}
