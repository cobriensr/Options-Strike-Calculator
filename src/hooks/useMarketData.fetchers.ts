/**
 * useMarketData.fetchers — Pure async fetch logic for market data endpoints.
 *
 * Extracted from useMarketData to separate network I/O from React state
 * management. Each function is independently testable and has no React
 * dependencies.
 */

import { getErrorMessage } from '../utils/error';
import type {
  QuotesResponse,
  IntradayResponse,
  YesterdayResponse,
  EventsResponse,
  MoversResponse,
} from '../types/api';

// ============================================================
// TYPES
// ============================================================

export interface MarketData {
  quotes: QuotesResponse | null;
  intraday: IntradayResponse | null;
  yesterday: YesterdayResponse | null;
  events: EventsResponse | null;
  movers: MoversResponse | null;
}

// ============================================================
// CONSTANTS
// ============================================================

/** Timeout for individual API fetches (ms). Prevents hung requests from stacking. */
const FETCH_TIMEOUT_MS = 10_000;

// ============================================================
// GENERIC FETCH HELPER
// ============================================================

export type FetchResult<T> = { data: T } | { error: string; status: number };

export async function fetchJson<T>(
  url: string,
  signal?: AbortSignal,
): Promise<FetchResult<T>> {
  try {
    // Combine caller signal (unmount) with a per-request timeout
    const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;

    const res = await fetch(url, {
      credentials: 'same-origin',
      signal: combinedSignal,
    });
    if (!res.ok) {
      const body = await res
        .json()
        .catch(() => ({ error: `HTTP ${res.status}` }));
      return {
        error: body.error || `HTTP ${res.status}`,
        status: res.status,
      };
    }
    const data: T = await res.json();
    return { data };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { error: 'Request aborted', status: 0 };
    }
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      return { error: 'Request timed out', status: 0 };
    }
    return {
      error: getErrorMessage(err),
      status: 0,
    };
  }
}

// ============================================================
// ENDPOINT FETCHERS
// ============================================================

export interface EndpointResults {
  quotes: FetchResult<QuotesResponse>;
  intraday: FetchResult<IntradayResponse>;
  yesterday: FetchResult<YesterdayResponse>;
  events: FetchResult<EventsResponse>;
  movers: FetchResult<MoversResponse>;
}

/** Fetch all five endpoints in parallel. */
export async function fetchAllEndpoints(): Promise<EndpointResults> {
  const [quotes, intraday, yesterday, events, movers] = await Promise.all([
    fetchJson<QuotesResponse>('/api/quotes'),
    fetchJson<IntradayResponse>('/api/intraday'),
    fetchJson<YesterdayResponse>('/api/yesterday'),
    fetchJson<EventsResponse>('/api/events?days=30'),
    fetchJson<MoversResponse>('/api/movers'),
  ]);

  return { quotes, intraday, yesterday, events, movers };
}

// ============================================================
// RESULT PROCESSING
// ============================================================

export interface ProcessedResults {
  nextData: MarketData;
  anySuccess: boolean;
  anyAuthError: boolean;
  /**
   * True specifically when the /api/quotes endpoint returned fresh data.
   * Tracked independently of `anySuccess` so downstream consumers can
   * compute quote-specific freshness (FE-STATE-001: the stale-data badge
   * must reflect SPX/VIX quote age, not the age of events/movers which
   * have their own cadences and shouldn't suppress a stale-quote warning).
   */
  quotesSuccess: boolean;
}

/**
 * Process raw endpoint results into the next MarketData state.
 * Pure function — no React dependencies.
 */
export function processEndpointResults(
  prev: MarketData,
  results: EndpointResults,
): ProcessedResults {
  let anySuccess = false;
  let anyAuthError = false;
  let quotesSuccess = false;
  const next = { ...prev };

  if ('data' in results.quotes) {
    next.quotes = results.quotes.data;
    anySuccess = true;
    quotesSuccess = true;
  } else if (results.quotes.status === 401) {
    anyAuthError = true;
  }

  if ('data' in results.intraday) {
    next.intraday = results.intraday.data;
    anySuccess = true;
  } else if (results.intraday.status === 401) {
    anyAuthError = true;
  }

  if ('data' in results.yesterday) {
    next.yesterday = results.yesterday.data;
    anySuccess = true;
  } else if (results.yesterday.status === 401) {
    anyAuthError = true;
  }

  // Events is public — always store if successful
  if ('data' in results.events) {
    next.events = results.events.data;
  }

  // Movers is owner-gated — silently skip 401s
  if ('data' in results.movers) {
    next.movers = results.movers.data;
    anySuccess = true;
  } else if (results.movers.status === 401) {
    anyAuthError = true;
  }

  return { nextData: next, anySuccess, anyAuthError, quotesSuccess };
}
