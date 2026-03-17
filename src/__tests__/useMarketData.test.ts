import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useMarketData } from '../hooks/useMarketData';

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

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
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
    const fetchMock = mockFetchResponses();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const initialCalls = fetchMock.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });

    // No additional calls since marketOpen is false
    expect(fetchMock.mock.calls.length).toBe(initialCalls);
  });

  it('cleans up interval on unmount', async () => {
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
