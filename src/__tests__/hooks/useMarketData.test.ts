import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useMarketData, computeMarketSession } from '../../hooks/useMarketData';

/**
 * Tests for the useMarketData React hook.
 * Mocks fetch to simulate the three API endpoints.
 */

// ============================================================
// MOCK DATA
// ============================================================

const mockQuotes = {
  spy: {
    price: 672,
    open: 677,
    high: 680,
    low: 673,
    prevClose: 677,
    change: -5,
    changePct: -0.7,
  },
  spx: {
    price: 6775,
    open: 6790,
    high: 6811,
    low: 6745,
    prevClose: 6781,
    change: -6,
    changePct: -0.08,
  },
  vix: {
    price: 24.23,
    open: 24.9,
    high: 26.23,
    low: 23.75,
    prevClose: 24.93,
    change: -0.7,
    changePct: -2.8,
  },
  vix1d: {
    price: 18.99,
    open: 14.93,
    high: 20.36,
    low: 14.14,
    prevClose: 21.29,
    change: -2.3,
    changePct: -10.8,
  },
  vix9d: {
    price: 24.44,
    open: 24.55,
    high: 26.69,
    low: 23.54,
    prevClose: 25.54,
    change: -1.1,
    changePct: -4.3,
  },
  marketOpen: false,
  asOf: '2026-03-11T20:00:00Z',
};

const mockIntraday = {
  today: { open: 6796.56, high: 6845.08, low: 6759.74, last: 6775.8 },
  openingRange: {
    high: 6798.96,
    low: 6762.05,
    rangePts: 36.91,
    minutes: 30,
    complete: true,
  },
  previousClose: 6795.99,
  candleCount: 78,
  marketOpen: false,
  asOf: '2026-03-11T20:00:00Z',
};

const mockYesterday = {
  yesterday: {
    date: '2026-03-10',
    open: 6681,
    high: 6810,
    low: 6636,
    close: 6781,
    rangePct: 2.61,
    rangePts: 174,
  },
  twoDaysAgo: null,
  asOf: '2026-03-11T08:00:00Z',
};

// ============================================================
// MOCK FETCH HELPER
// ============================================================

interface MockEndpoint {
  status: number;
  body: Record<string, unknown> | null;
}

function mockFetchResponses(
  overrides: {
    quotes?: MockEndpoint;
    intraday?: MockEndpoint;
    yesterday?: MockEndpoint;
    events?: MockEndpoint;
    movers?: MockEndpoint;
  } = {},
) {
  const defaults: Record<string, MockEndpoint> = {
    quotes: { status: 200, body: mockQuotes },
    intraday: { status: 200, body: mockIntraday },
    yesterday: { status: 200, body: mockYesterday },
    events: {
      status: 200,
      body: { events: [], startDate: '', endDate: '', cached: false, asOf: '' },
    },
    movers: { status: 200, body: { up: [], down: [], asOf: '' } },
  };

  return vi.fn((...args: [url: string, init?: RequestInit]) => {
    const url = args[0];
    let endpoint: MockEndpoint = defaults.quotes!;
    if (url.includes('/api/quotes'))
      endpoint = overrides.quotes ?? defaults.quotes!;
    else if (url.includes('/api/intraday'))
      endpoint = overrides.intraday ?? defaults.intraday!;
    else if (url.includes('/api/yesterday'))
      endpoint = overrides.yesterday ?? defaults.yesterday!;
    else if (url.includes('/api/events'))
      endpoint = overrides.events ?? defaults.events!;
    else if (url.includes('/api/movers'))
      endpoint = overrides.movers ?? defaults.movers!;

    return Promise.resolve({
      ok: endpoint.status >= 200 && endpoint.status < 300,
      status: endpoint.status,
      json: () => Promise.resolve(endpoint.body),
    });
  });
}

// FE-STATE-002: instants used to drive the client-side session classifier.
// `useMarketData` derives `session` from wall-clock time via
// `computeMarketSession`, so each test needs a deterministic `new Date()`
// via `vi.setSystemTime`. These constants name a few useful ET moments.
//
// Sanity: DST starts 2026-03-08, ends 2026-11-01, so 2026-04-09 is EDT
// (UTC-4). All trading-day instants below are on days that are NOT NYSE
// holidays per `src/data/marketHours.ts`.
//
//   Thu 2026-04-09 14:00 UTC → 10:00 EDT → `regular`
//   Thu 2026-04-09 12:00 UTC → 08:00 EDT → `pre-market`
//   Thu 2026-04-09 22:00 UTC → 18:00 EDT → `after-hours`
//   Sat 2026-04-11 14:00 UTC → 10:00 EDT → `closed` (weekend)
const REGULAR_HOURS = new Date(Date.UTC(2026, 3, 9, 14, 0, 0));
const PRE_MARKET = new Date(Date.UTC(2026, 3, 9, 12, 0, 0));
const AFTER_HOURS = new Date(Date.UTC(2026, 3, 9, 22, 0, 0));
const SESSION_CLOSED_WEEKEND = new Date(Date.UTC(2026, 3, 11, 14, 0, 0));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // Default to a closed session so tests that don't advance timers never
  // accidentally trigger the auto-refresh interval. Tests that need
  // polling to run override this with `vi.setSystemTime(REGULAR_HOURS)`
  // (or similar) before `renderHook`.
  vi.setSystemTime(SESSION_CLOSED_WEEKEND);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ============================================================
// BASIC BEHAVIOR
// ============================================================

describe('useMarketData: basic behavior', () => {
  it('starts with loading=true', async () => {
    globalThis.fetch = mockFetchResponses() as unknown as typeof fetch;
    const { result } = renderHook(() => useMarketData());
    expect(result.current.loading).toBe(true);
    // Let the mount effect's fetch settle so state updates don't leak
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it('loads all three endpoints successfully', async () => {
    globalThis.fetch = mockFetchResponses() as unknown as typeof fetch;
    const { result } = renderHook(() => useMarketData());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data.quotes).not.toBeNull();
    expect(result.current.data.intraday).not.toBeNull();
    expect(result.current.data.yesterday).not.toBeNull();
    expect(result.current.hasData).toBe(true);
    expect(result.current.needsAuth).toBe(false);
  });

  it('sets lastUpdated after successful fetch', async () => {
    globalThis.fetch = mockFetchResponses() as unknown as typeof fetch;
    const { result } = renderHook(() => useMarketData());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.lastUpdated).not.toBeNull();
  });
});

// ============================================================
// OWNER GATING (401 HANDLING)
// ============================================================

describe('useMarketData: owner gating', () => {
  it('silently handles all-401s (public visitor)', async () => {
    globalThis.fetch = mockFetchResponses({
      quotes: { status: 401, body: { error: 'Not authenticated' } },
      intraday: { status: 401, body: { error: 'Not authenticated' } },
      yesterday: { status: 401, body: { error: 'Not authenticated' } },
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data.quotes).toBeNull();
    expect(result.current.data.intraday).toBeNull();
    expect(result.current.data.yesterday).toBeNull();
    expect(result.current.hasData).toBe(false);
  });

  it('partial success: one endpoint works, others 401', async () => {
    globalThis.fetch = mockFetchResponses({
      quotes: { status: 200, body: mockQuotes },
      intraday: { status: 401, body: { error: 'Not authenticated' } },
      yesterday: { status: 401, body: { error: 'Not authenticated' } },
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data.quotes).not.toBeNull();
    expect(result.current.data.intraday).toBeNull();
    expect(result.current.data.yesterday).toBeNull();
    expect(result.current.hasData).toBe(true);
  });
});

// ============================================================
// ERROR HANDLING
// ============================================================

describe('useMarketData: error handling', () => {
  it('handles network errors gracefully', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error('Network error')),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.hasData).toBe(false);
  });

  it('handles 500 errors gracefully', async () => {
    globalThis.fetch = mockFetchResponses({
      quotes: { status: 500, body: { error: 'Internal error' } },
      intraday: { status: 500, body: { error: 'Internal error' } },
      yesterday: { status: 500, body: { error: 'Internal error' } },
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.hasData).toBe(false);
  });

  it('mixed: one success, one 500, one network error', async () => {
    globalThis.fetch = vi.fn((url: string) => {
      if (url.includes('/api/quotes')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockQuotes),
        });
      }
      if (url.includes('/api/intraday')) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ error: 'fail' }),
        });
      }
      return Promise.reject(new Error('Network error'));
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data.quotes).not.toBeNull();
    expect(result.current.data.intraday).toBeNull();
    expect(result.current.data.yesterday).toBeNull();
    expect(result.current.hasData).toBe(true);
  });
});

// ============================================================
// REFRESH
// ============================================================

describe('useMarketData: manual refresh', () => {
  it('refresh() re-fetches all endpoints', async () => {
    const fetchMock = mockFetchResponses();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const callsBefore = fetchMock.mock.calls.length;
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });
});

// ============================================================
// CREDENTIALS
// ============================================================

describe('useMarketData: fetch options', () => {
  it('sends credentials: same-origin with every request', async () => {
    const fetchMock = mockFetchResponses();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      expect(init?.credentials).toBe('same-origin');
    }
  });
});

// ============================================================
// FETCH JSON EDGE CASES
// ============================================================

describe('useMarketData: fetchJson edge cases', () => {
  it('handles non-ok response where .json() throws (line 65)', async () => {
    globalThis.fetch = vi.fn((url: string) => {
      if (url.includes('/api/quotes')) {
        return Promise.resolve({
          ok: false,
          status: 502,
          json: () => Promise.reject(new Error('bad gateway html')),
        });
      }
      // Other endpoints succeed
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => {
          if (url.includes('/api/intraday'))
            return Promise.resolve(mockIntraday);
          if (url.includes('/api/yesterday'))
            return Promise.resolve(mockYesterday);
          if (url.includes('/api/events'))
            return Promise.resolve({ events: [] });
          if (url.includes('/api/movers'))
            return Promise.resolve({ up: [], down: [] });
          return Promise.resolve({});
        },
      });
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Quotes failed but others succeeded
    expect(result.current.data.quotes).toBeNull();
    expect(result.current.data.intraday).not.toBeNull();
    expect(result.current.hasData).toBe(true);
  });

  it('handles non-Error throw from fetch (line 75)', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new TypeError('string error')),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.hasData).toBe(false);
  });
});

// ============================================================
// AUTO-REFRESH (lines 184-192)
// ============================================================

describe('useMarketData: auto-refresh', () => {
  it('auto-refreshes quotes every 60s when market is open', async () => {
    // FE-STATE-002: session derives from wall-clock, not the response body.
    vi.setSystemTime(REGULAR_HOURS);
    const mockQuotesOpen = { ...mockQuotes, marketOpen: true };
    const fetchMock = mockFetchResponses({
      quotes: {
        status: 200,
        body: mockQuotesOpen as unknown as Record<string, unknown>,
      },
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Initial fetch: 5 endpoints
    const initialCalls = fetchMock.mock.calls.length;
    expect(initialCalls).toBe(5);

    // Advance past the refresh interval
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    // Should have made one additional quotes fetch
    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThan(initialCalls),
    );

    // The extra call should be to /api/quotes
    const lastCallUrl = fetchMock.mock.calls.at(-1)![0];
    expect(lastCallUrl).toBe('/api/quotes');
  });

  it('does not auto-refresh when market is closed', async () => {
    // FE-STATE-002: `closed` session (default weekend time) gates polling
    // off regardless of what the /api/quotes response says about
    // `marketOpen`.
    const fetchMock = mockFetchResponses();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const initialCalls = fetchMock.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });

    // No additional calls since session is 'closed'.
    expect(fetchMock.mock.calls.length).toBe(initialCalls);
  });

  it('cleans up interval on unmount', async () => {
    vi.setSystemTime(REGULAR_HOURS);
    const mockQuotesOpen = { ...mockQuotes, marketOpen: true };
    const fetchMock = mockFetchResponses({
      quotes: {
        status: 200,
        body: mockQuotesOpen as unknown as Record<string, unknown>,
      },
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result, unmount } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const callsAfterMount = fetchMock.mock.calls.length;
    unmount();

    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });

    // No new calls after unmount
    expect(fetchMock.mock.calls.length).toBe(callsAfterMount);
  });
});

// ============================================================
// EVENTS & MOVERS ENDPOINTS
// ============================================================

describe('useMarketData: events and movers', () => {
  it('stores events data when endpoint succeeds', async () => {
    const mockEvents = {
      events: [
        {
          date: '2026-03-11',
          event: 'CPI',
          description: 'CPI',
          time: '8:30 AM',
          severity: 'high',
        },
      ],
      startDate: '2026-03-01',
      endDate: '2026-03-31',
      cached: false,
      asOf: '2026-03-11T08:00:00Z',
    };
    const fetchMock = mockFetchResponses({
      events: {
        status: 200,
        body: mockEvents as unknown as Record<string, unknown>,
      },
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data.events).not.toBeNull();
  });

  it('stores movers data when endpoint succeeds', async () => {
    const mockMovers = {
      up: [{ symbol: 'AAPL', changePct: 5 }],
      down: [],
      asOf: '',
    };
    const fetchMock = mockFetchResponses({
      movers: {
        status: 200,
        body: mockMovers as unknown as Record<string, unknown>,
      },
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data.movers).not.toBeNull();
  });

  it('handles 401 on movers silently', async () => {
    const fetchMock = mockFetchResponses({
      movers: { status: 401, body: { error: 'Not authenticated' } },
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data.movers).toBeNull();
    expect(result.current.hasData).toBe(true); // Other endpoints succeeded
  });
});

// ============================================================
// ABORT / TIMEOUT ERROR BRANCHES (lines 88, 91)
// ============================================================

describe('useMarketData: AbortError and TimeoutError branches', () => {
  it('handles AbortError from fetch (line 88)', async () => {
    globalThis.fetch = vi.fn(() => {
      const err = new DOMException('The operation was aborted.', 'AbortError');
      return Promise.reject(err);
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.hasData).toBe(false);
    expect(result.current.data.quotes).toBeNull();
    expect(result.current.data.intraday).toBeNull();
    expect(result.current.data.yesterday).toBeNull();
  });

  it('handles TimeoutError from fetch (line 91)', async () => {
    globalThis.fetch = vi.fn(() => {
      const err = new DOMException('The operation timed out.', 'TimeoutError');
      return Promise.reject(err);
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.hasData).toBe(false);
    expect(result.current.data.quotes).toBeNull();
    expect(result.current.data.intraday).toBeNull();
    expect(result.current.data.yesterday).toBeNull();
  });
});

// ============================================================
// NEEDS AUTH BRANCH (line 185)
// ============================================================

describe('useMarketData: needsAuth transition (line 185)', () => {
  it('sets needsAuth when owner was previously authenticated but now gets 401s', async () => {
    // Set sc-hint cookie so isOwnerRef starts as true (simulates prior auth session)
    Object.defineProperty(document, 'cookie', {
      value: 'sc-hint=1',
      writable: true,
      configurable: true,
    });

    // All owner-gated endpoints return 401, events returns 200 (public)
    const fetchMock = mockFetchResponses({
      quotes: { status: 401, body: { error: 'Not authenticated' } },
      intraday: { status: 401, body: { error: 'Not authenticated' } },
      yesterday: { status: 401, body: { error: 'Not authenticated' } },
      movers: { status: 401, body: { error: 'Not authenticated' } },
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // isOwnerRef was true from cookie, all gated endpoints 401'd, no success
    expect(result.current.needsAuth).toBe(true);

    // Clean up cookie
    Object.defineProperty(document, 'cookie', {
      value: '',
      writable: true,
      configurable: true,
    });
  });
});

// ============================================================
// INTERVAL INTRADAY REFRESH (lines 220-223)
// ============================================================

describe('useMarketData: interval intraday refresh (lines 220-223)', () => {
  it('refreshes intraday during interval when openingRange is not complete', async () => {
    // FE-STATE-002: intraday refresh is gated on session === 'regular'.
    vi.setSystemTime(REGULAR_HOURS);
    const mockIntradayIncomplete = {
      ...mockIntraday,
      openingRange: { ...mockIntraday.openingRange, complete: false },
    };
    const mockQuotesOpen = { ...mockQuotes, marketOpen: true };
    const fetchMock = mockFetchResponses({
      quotes: {
        status: 200,
        body: mockQuotesOpen as unknown as Record<string, unknown>,
      },
      intraday: {
        status: 200,
        body: mockIntradayIncomplete as unknown as Record<string, unknown>,
      },
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Initial: 5 calls (quotes, intraday, yesterday, events, movers)
    const initialCalls = fetchMock.mock.calls.length;
    expect(initialCalls).toBe(5);

    // Advance past the refresh interval
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    // Should have fetched both quotes AND intraday in the interval
    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(
        initialCalls + 2,
      ),
    );

    // Verify that both /api/quotes and /api/intraday were called in the interval
    const intervalCalls = fetchMock.mock.calls.slice(initialCalls);
    const intervalUrls = intervalCalls.map(
      (call: [string, ...unknown[]]) => call[0],
    );
    expect(intervalUrls).toContain('/api/quotes');
    expect(intervalUrls).toContain('/api/intraday');
  });
});

// ============================================================
// FE-STATE-001: QUOTES-SPECIFIC STALENESS FLAGS
// ============================================================

describe('useMarketData: FE-STATE-001 staleness flags', () => {
  const mockQuotesOpen = { ...mockQuotes, marketOpen: true };
  const mockQuotesClosed = { ...mockQuotes, marketOpen: false };

  it('isStale is false on initial mount (no fetches yet)', async () => {
    // Default beforeEach sets a closed session, which is what this test
    // wants: no polling, no staleness tick, staleness stays false.
    globalThis.fetch = mockFetchResponses() as unknown as typeof fetch;
    const { result } = renderHook(() => useMarketData());
    expect(result.current.isStale).toBe(false);
    expect(result.current.isVeryStale).toBe(false);
    expect(result.current.quotesLastUpdated).toBeNull();
    // Let the mount fetch settle so the trailing setData/setLoading
    // state updates don't leak past the test boundary and trigger
    // React's "update not wrapped in act" warning.
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it('populates quotesLastUpdated when quotes fetch succeeds', async () => {
    vi.setSystemTime(REGULAR_HOURS);
    globalThis.fetch = mockFetchResponses({
      quotes: { status: 200, body: mockQuotesOpen },
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useMarketData());
    await waitFor(() =>
      expect(result.current.quotesLastUpdated).not.toBeNull(),
    );
    // Freshly fetched → not stale.
    expect(result.current.isStale).toBe(false);
    expect(result.current.isVeryStale).toBe(false);
  });

  it('transitions to isStale after 90s elapse while market is open', async () => {
    vi.setSystemTime(REGULAR_HOURS);
    globalThis.fetch = mockFetchResponses({
      quotes: { status: 200, body: mockQuotesOpen },
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useMarketData());
    await waitFor(() =>
      expect(result.current.quotesLastUpdated).not.toBeNull(),
    );

    // Hijack the next poll by making the quotes endpoint return stale data
    // (same timestamps) AND prevent the auto-refresh from touching
    // quotesLastUpdated: we want to observe the force-tick advancing the
    // staleness flag purely via wall-clock passing. We use 401s so the
    // fetch completes but quotesSuccess stays false.
    globalThis.fetch = mockFetchResponses({
      quotes: { status: 401, body: null },
      intraday: { status: 401, body: null },
      yesterday: { status: 401, body: null },
      events: { status: 401, body: null },
      movers: { status: 401, body: null },
    }) as unknown as typeof fetch;

    // Advance past the 90s staleness threshold. The 5s force-tick inside
    // the hook should trigger a re-render that re-evaluates `isStale`.
    await act(async () => {
      vi.advanceTimersByTime(95_000);
    });

    expect(result.current.isStale).toBe(true);
    expect(result.current.isVeryStale).toBe(false);
  });

  it('transitions to isVeryStale after 180s elapse while market is open', async () => {
    vi.setSystemTime(REGULAR_HOURS);
    globalThis.fetch = mockFetchResponses({
      quotes: { status: 200, body: mockQuotesOpen },
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useMarketData());
    await waitFor(() =>
      expect(result.current.quotesLastUpdated).not.toBeNull(),
    );

    // Subsequent polls 401 so quotesLastUpdated stays pinned.
    globalThis.fetch = mockFetchResponses({
      quotes: { status: 401, body: null },
      intraday: { status: 401, body: null },
      yesterday: { status: 401, body: null },
      events: { status: 401, body: null },
      movers: { status: 401, body: null },
    }) as unknown as typeof fetch;

    await act(async () => {
      vi.advanceTimersByTime(185_000);
    });

    expect(result.current.isStale).toBe(true);
    expect(result.current.isVeryStale).toBe(true);
  });

  it('does NOT flag staleness when market is closed (even with old quotes)', async () => {
    // Market-closed scenario: quotes came in, market is closed, then
    // a long time passes. The staleness flags should remain false
    // because polling has intentionally stopped — showing "STALE" for
    // 17 hours every overnight is pure noise.
    //
    // FE-STATE-002: rely on the default beforeEach `SESSION_CLOSED_WEEKEND`
    // so the client-side session classifier returns 'closed'.
    globalThis.fetch = mockFetchResponses({
      quotes: { status: 200, body: mockQuotesClosed },
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useMarketData());
    await waitFor(() =>
      expect(result.current.quotesLastUpdated).not.toBeNull(),
    );

    // Advance way past both thresholds.
    await act(async () => {
      vi.advanceTimersByTime(300_000);
    });

    expect(result.current.isStale).toBe(false);
    expect(result.current.isVeryStale).toBe(false);
  });

  it('resets isStale after a fresh successful quotes fetch', async () => {
    vi.setSystemTime(REGULAR_HOURS);
    globalThis.fetch = mockFetchResponses({
      quotes: { status: 200, body: mockQuotesOpen },
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useMarketData());
    await waitFor(() =>
      expect(result.current.quotesLastUpdated).not.toBeNull(),
    );

    // Drift into stale territory by letting the interval polls 401.
    globalThis.fetch = mockFetchResponses({
      quotes: { status: 401, body: null },
      intraday: { status: 401, body: null },
      yesterday: { status: 401, body: null },
      events: { status: 401, body: null },
      movers: { status: 401, body: null },
    }) as unknown as typeof fetch;
    await act(async () => {
      vi.advanceTimersByTime(95_000);
    });
    expect(result.current.isStale).toBe(true);

    // Now install a healthy endpoint again and manually trigger a
    // refresh. After quotes come back, staleness should reset.
    globalThis.fetch = mockFetchResponses({
      quotes: { status: 200, body: mockQuotesOpen },
    }) as unknown as typeof fetch;
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.isStale).toBe(false);
    expect(result.current.isVeryStale).toBe(false);
  });

  it('quote-specific: events-only updates do NOT reset stale flag', async () => {
    // Scenario: /api/quotes 401s, /api/events succeeds. The whole-state
    // lastUpdated advances (because events came through), but
    // quotesLastUpdated does NOT, and `isStale` should still flip true
    // once 90s pass since the last quotes success. This is the Decision 4
    // "quotes-specific staleness" behavior — events/movers freshness
    // should never mask a stale quotes warning.
    vi.setSystemTime(REGULAR_HOURS);
    globalThis.fetch = mockFetchResponses({
      quotes: { status: 200, body: mockQuotesOpen },
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useMarketData());
    await waitFor(() =>
      expect(result.current.quotesLastUpdated).not.toBeNull(),
    );

    // Now quotes 401 but events keep succeeding.
    globalThis.fetch = mockFetchResponses({
      quotes: { status: 401, body: null },
      intraday: { status: 401, body: null },
      yesterday: { status: 401, body: null },
      // events + movers default to 200
    }) as unknown as typeof fetch;

    await act(async () => {
      vi.advanceTimersByTime(95_000);
    });

    // lastUpdated may have advanced (events are still fetching), but
    // quotesLastUpdated is pinned, so isStale fires.
    expect(result.current.isStale).toBe(true);
  });
});

// ============================================================
// FE-STATE-002: TRI-STATE MARKET SESSION
// ============================================================

describe('computeMarketSession: pure classifier', () => {
  // All instants assume 2026 post-DST dates (DST starts 2026-03-08).
  // Trading day references:
  //   Thu 2026-04-09  normal full trading day (EDT)
  //   Fri 2026-11-27  NYSE early-close half-day (EST)  13:00 ET close
  //   Sat 2026-04-11  weekend
  //   Mon 2026-01-19  MLK Day full-day holiday (EST)
  //
  // Each case feeds a specific UTC instant → asserts the ET-derived
  // session label. The session classifier is the single source of
  // truth for the polling gates, so this block exercises it directly.

  it('returns "closed" before 04:00 ET on a trading day', () => {
    // Thu 2026-04-09 03:30 EDT = 07:30 UTC
    expect(computeMarketSession(new Date(Date.UTC(2026, 3, 9, 7, 30, 0)))).toBe(
      'closed',
    );
  });

  it('returns "pre-market" at 08:00 ET on a trading day', () => {
    // Thu 2026-04-09 08:00 EDT = 12:00 UTC — the 08:30 CT prep window
    expect(computeMarketSession(new Date(Date.UTC(2026, 3, 9, 12, 0, 0)))).toBe(
      'pre-market',
    );
  });

  it('returns "pre-market" at 09:29 ET (one minute before open)', () => {
    // Thu 2026-04-09 09:29 EDT = 13:29 UTC
    expect(
      computeMarketSession(new Date(Date.UTC(2026, 3, 9, 13, 29, 0))),
    ).toBe('pre-market');
  });

  it('returns "regular" at 09:30 ET (opening bell)', () => {
    // Thu 2026-04-09 09:30 EDT = 13:30 UTC
    expect(
      computeMarketSession(new Date(Date.UTC(2026, 3, 9, 13, 30, 0))),
    ).toBe('regular');
  });

  it('returns "regular" at 10:00 ET on a trading day', () => {
    // Thu 2026-04-09 10:00 EDT = 14:00 UTC
    expect(computeMarketSession(new Date(Date.UTC(2026, 3, 9, 14, 0, 0)))).toBe(
      'regular',
    );
  });

  it('returns "after-hours" at 16:00 ET (closing bell)', () => {
    // Thu 2026-04-09 16:00 EDT = 20:00 UTC
    expect(computeMarketSession(new Date(Date.UTC(2026, 3, 9, 20, 0, 0)))).toBe(
      'after-hours',
    );
  });

  it('returns "after-hours" at 18:00 ET on a trading day', () => {
    // Thu 2026-04-09 18:00 EDT = 22:00 UTC
    expect(computeMarketSession(new Date(Date.UTC(2026, 3, 9, 22, 0, 0)))).toBe(
      'after-hours',
    );
  });

  it('returns "closed" at 20:00 ET (extended hours end)', () => {
    // Thu 2026-04-09 20:00 EDT = 24:00 UTC (midnight)
    expect(computeMarketSession(new Date(Date.UTC(2026, 3, 10, 0, 0, 0)))).toBe(
      'closed',
    );
  });

  it('returns "closed" on weekends', () => {
    // Sat 2026-04-11 10:00 EDT = 14:00 UTC
    expect(
      computeMarketSession(new Date(Date.UTC(2026, 3, 11, 14, 0, 0))),
    ).toBe('closed');
  });

  it('returns "closed" on full-day NYSE holidays', () => {
    // Mon 2026-01-19 MLK Day 10:00 EST = 15:00 UTC
    expect(
      computeMarketSession(new Date(Date.UTC(2026, 0, 19, 15, 0, 0))),
    ).toBe('closed');
  });

  it('half-day: 12:30 ET is still "regular" (before 13:00 ET early close)', () => {
    // Fri 2026-11-27 Black Friday early-close. In November we are on EST (UTC-5).
    // 12:30 EST = 17:30 UTC.
    expect(
      computeMarketSession(new Date(Date.UTC(2026, 10, 27, 17, 30, 0))),
    ).toBe('regular');
  });

  it('half-day: 13:30 ET is "after-hours" (past 13:00 ET early close)', () => {
    // Fri 2026-11-27 13:30 EST = 18:30 UTC.
    expect(
      computeMarketSession(new Date(Date.UTC(2026, 10, 27, 18, 30, 0))),
    ).toBe('after-hours');
  });

  it('half-day: 16:00 ET is still "after-hours" (before 20:00 ET extended close)', () => {
    // Fri 2026-11-27 16:00 EST = 21:00 UTC. On a full day this is the
    // 16:00 open → close transition; on a half-day the after-hours
    // window continues all the way to 20:00 ET.
    expect(
      computeMarketSession(new Date(Date.UTC(2026, 10, 27, 21, 0, 0))),
    ).toBe('after-hours');
  });
});

describe('useMarketData: FE-STATE-002 session gating', () => {
  const mockQuotesOpen = { ...mockQuotes, marketOpen: true };

  it('exposes session === "regular" during RTH', async () => {
    vi.setSystemTime(REGULAR_HOURS);
    globalThis.fetch = mockFetchResponses() as unknown as typeof fetch;
    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.session).toBe('regular');
    // Backward-compat alias: marketOpen === true iff session === 'regular'.
    expect(result.current.marketOpen).toBe(true);
  });

  it('exposes session === "pre-market" during pre-market hours', async () => {
    vi.setSystemTime(PRE_MARKET);
    globalThis.fetch = mockFetchResponses() as unknown as typeof fetch;
    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.session).toBe('pre-market');
    // marketOpen remains false in pre-market — it's a strict RTH alias.
    expect(result.current.marketOpen).toBe(false);
  });

  it('exposes session === "after-hours" during extended hours', async () => {
    vi.setSystemTime(AFTER_HOURS);
    globalThis.fetch = mockFetchResponses() as unknown as typeof fetch;
    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.session).toBe('after-hours');
    expect(result.current.marketOpen).toBe(false);
  });

  it('exposes session === "closed" on weekends', async () => {
    // Default beforeEach already sets SESSION_CLOSED_WEEKEND.
    globalThis.fetch = mockFetchResponses() as unknown as typeof fetch;
    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.session).toBe('closed');
    expect(result.current.marketOpen).toBe(false);
  });

  it('polls the quotes endpoint during pre-market (unlocks 08:30 CT prep)', async () => {
    vi.setSystemTime(PRE_MARKET);
    const fetchMock = mockFetchResponses();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Initial mount: 5 calls (quotes + intraday + yesterday + events + movers)
    const initialCalls = fetchMock.mock.calls.length;
    expect(initialCalls).toBe(5);

    // Advance past the refresh interval — pre-market should still poll
    // quotes because the trader's prep workflow depends on seeing SPX.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThan(initialCalls),
    );

    // The incremental poll must be quotes (the only gate that opens in
    // pre-market). Assert it's NOT the intraday endpoint — that's
    // RTH-only and would waste a quota call if it fired in pre-market.
    const intervalUrls = fetchMock.mock.calls
      .slice(initialCalls)
      .map((call: [string, ...unknown[]]) => call[0]);
    expect(intervalUrls).toContain('/api/quotes');
    expect(intervalUrls).not.toContain('/api/intraday');
  });

  it('polls the quotes endpoint during after-hours', async () => {
    vi.setSystemTime(AFTER_HOURS);
    const fetchMock = mockFetchResponses();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const initialCalls = fetchMock.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThan(initialCalls),
    );

    const intervalUrls = fetchMock.mock.calls
      .slice(initialCalls)
      .map((call: [string, ...unknown[]]) => call[0]);
    expect(intervalUrls).toContain('/api/quotes');
    expect(intervalUrls).not.toContain('/api/intraday');
  });

  it('does NOT poll the opening-range (intraday) endpoint in pre-market', async () => {
    // Same as the pre-market poll test but with intraday.openingRange
    // explicitly marked incomplete — this is the condition under which
    // the RTH interval WOULD re-fetch intraday. Pre-market must skip it.
    vi.setSystemTime(PRE_MARKET);
    const mockIntradayIncomplete = {
      ...mockIntraday,
      openingRange: { ...mockIntraday.openingRange, complete: false },
    };
    const fetchMock = mockFetchResponses({
      intraday: {
        status: 200,
        body: mockIntradayIncomplete as unknown as Record<string, unknown>,
      },
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const initialCalls = fetchMock.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThan(initialCalls),
    );

    const intervalUrls = fetchMock.mock.calls
      .slice(initialCalls)
      .map((call: [string, ...unknown[]]) => call[0]);
    // Quotes poll runs in pre-market (extended hours gate opens it).
    expect(intervalUrls).toContain('/api/quotes');
    // Intraday is RTH-only and must NOT fire in pre-market even though
    // the opening range is incomplete.
    expect(intervalUrls).not.toContain('/api/intraday');
  });

  it('polls the intraday endpoint during RTH when opening range is incomplete', async () => {
    // Mirror of the pre-market gate: in regular hours the RTH-only
    // gate opens and intraday IS refreshed alongside quotes.
    vi.setSystemTime(REGULAR_HOURS);
    const mockIntradayIncomplete = {
      ...mockIntraday,
      openingRange: { ...mockIntraday.openingRange, complete: false },
    };
    const fetchMock = mockFetchResponses({
      quotes: {
        status: 200,
        body: mockQuotesOpen as unknown as Record<string, unknown>,
      },
      intraday: {
        status: 200,
        body: mockIntradayIncomplete as unknown as Record<string, unknown>,
      },
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const initialCalls = fetchMock.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThan(initialCalls),
    );

    const intervalUrls = fetchMock.mock.calls
      .slice(initialCalls)
      .map((call: [string, ...unknown[]]) => call[0]);
    expect(intervalUrls).toContain('/api/quotes');
    expect(intervalUrls).toContain('/api/intraday');
  });

  it('does not poll anything in a "closed" session', async () => {
    // Default beforeEach has SESSION_CLOSED_WEEKEND set.
    const fetchMock = mockFetchResponses();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const initialCalls = fetchMock.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    expect(fetchMock.mock.calls.length).toBe(initialCalls);
    expect(result.current.session).toBe('closed');
  });
});
