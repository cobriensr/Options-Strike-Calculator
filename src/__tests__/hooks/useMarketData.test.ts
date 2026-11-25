import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { StrictMode, createElement, type ReactNode } from 'react';
import { useMarketData, computeMarketSession } from '../../hooks/useMarketData';
import { captureUnlessAuth } from '../../lib/sentry-helpers';
import type { AccessMode } from '../../utils/auth';

vi.mock('../../lib/sentry-helpers', () => ({
  captureUnlessAuth: vi.fn(),
}));
const mockCaptureUnlessAuth = vi.mocked(captureUnlessAuth);

// The hook reads its access mode at every render, so a test flips it between
// renders. `getAccessMode` is the one function the hook imports. The default
// is 'owner', which is what vitest's `import.meta.env.DEV` resolves to, so a
// test that never touches the mode keeps the meaning it had.
const access = vi.hoisted(() => ({ mode: 'owner' as AccessMode }));
vi.mock('../../utils/auth', () => ({
  getAccessMode: () => access.mode,
}));

// Wrapper that mounts the hook under React StrictMode so updaters and effects
// are double-invoked in dev, exactly as they are in the real app's
// `<StrictMode>` root. Used by the AUD-M16 regression test below.
function StrictWrapper({ children }: { children: ReactNode }) {
  return createElement(StrictMode, null, children);
}

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
  // The session the range is from: the date of the REGULAR_HOURS,
  // PRE_MARKET and AFTER_HOURS instants below, so a held range reads as
  // today's complete one in those tests.
  sessionDate: '2026-04-09',
  previousClose: 6795.99,
  candleCount: 78,
  marketOpen: false,
  asOf: '2026-03-11T20:00:00Z',
};

// The last trading day before the REGULAR_HOURS, PRE_MARKET and AFTER_HOURS
// instants (Thu 2026-04-09): the one currentYesterday accepts for them.
const mockYesterday = {
  yesterday: {
    date: '2026-04-08',
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

/** The URLs a fetch mock was called with, from call number `from` on. */
function urlsFrom(
  fetchMock: ReturnType<typeof mockFetchResponses>,
  from: number,
) {
  return fetchMock.mock.calls
    .slice(from)
    .map((call: [string, ...unknown[]]) => call[0]);
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
  mockCaptureUnlessAuth.mockReset();
  access.mode = 'owner';
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

  it('sets fetchedAt after successful fetch', async () => {
    globalThis.fetch = mockFetchResponses() as unknown as typeof fetch;
    const before = Date.now();
    const { result } = renderHook(() => useMarketData());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.fetchedAt).not.toBeNull();
    // Epoch ms: must be a finite number from the recent past.
    expect(result.current.fetchedAt!).toBeGreaterThanOrEqual(before);
    expect(result.current.fetchedAt!).toBeLessThanOrEqual(Date.now());
  });
});

// ============================================================
// OWNER GATING (401 HANDLING)
// ============================================================

describe('useMarketData: owner gating', () => {
  // A public visitor makes none of these requests (see "public visitor"
  // below). The all-401 case is a signed-in session the server no longer
  // honours: a guest key that was revoked, or an owner whose cookie lapsed
  // before the interceptor cleared the hint.
  it.each<AccessMode>(['owner', 'guest'])(
    'silently handles all-401s from a %s whose session is gone',
    async (mode) => {
      access.mode = mode;
      const denied = { status: 401, body: { error: 'Not authenticated' } };
      const fetchMock = mockFetchResponses({
        quotes: denied,
        intraday: denied,
        yesterday: denied,
        movers: denied,
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const { result } = renderHook(() => useMarketData());
      await waitFor(() => expect(result.current.loading).toBe(false));

      // The five-endpoint fan-out ran, and each 401 was dropped silently.
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(result.current.data.quotes).toBeNull();
      expect(result.current.data.intraday).toBeNull();
      expect(result.current.data.yesterday).toBeNull();
      expect(result.current.data.movers).toBeNull();
      expect(result.current.hasData).toBe(false);
      expect(mockCaptureUnlessAuth).not.toHaveBeenCalled();
    },
  );

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
            return Promise.resolve({
              events: [],
              startDate: '',
              endDate: '',
              cached: false,
              asOf: '',
            });
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
  const validEvent = {
    date: '2026-03-11',
    event: 'CPI',
    description: 'CPI',
    time: '8:30 AM',
    severity: 'high',
    source: 'fred',
  };
  const eventsRange = { startDate: '2026-03-01', endDate: '2026-03-31' };

  it('stores events data when endpoint succeeds', async () => {
    const mockEvents = {
      events: [validEvent],
      ...eventsRange,
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

    // Stored as received: the schema leaves `cached` and `asOf` out, and
    // must not strip them from what is stored.
    expect(result.current.data.events).toEqual(mockEvents);
    expect(mockCaptureUnlessAuth).not.toHaveBeenCalled();
  });

  it.each([
    ['events is not an array', { events: 'nope', ...eventsRange }],
    [
      'an event has no source',
      {
        events: [{ ...validEvent, source: undefined }],
        ...eventsRange,
      },
    ],
    [
      'an event has an unknown severity',
      {
        events: [{ ...validEvent, severity: 'extreme' }],
        ...eventsRange,
      },
    ],
    ['startDate is missing', { events: [], endDate: eventsRange.endDate }],
    ['endDate is missing', { events: [], startDate: eventsRange.startDate }],
  ])(
    'leaves events null and reports to Sentry when the forward list has %s',
    async (_name, malformed) => {
      const fetchMock = mockFetchResponses({
        events: {
          status: 200,
          body: malformed as unknown as Record<string, unknown>,
        },
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const { result } = renderHook(() => useMarketData());
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.data.events).toBeNull();
      // Only the events entry is dropped; the other endpoints are stored.
      expect(result.current.data.quotes).not.toBeNull();
      expect(result.current.data.movers).not.toBeNull();
      expect(mockCaptureUnlessAuth).toHaveBeenCalledTimes(1);
      const [error, options] = mockCaptureUnlessAuth.mock.calls[0]!;
      expect((error as Error).message).toBe(
        'events response failed schema validation',
      );
      expect(options).toMatchObject({
        contexts: {
          events: { request: 'forward', issueCount: expect.any(Number) },
        },
      });
    },
  );

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
// NEEDS AUTH: THE OWNER'S SCHWAB RE-AUTH PROMPT
// ============================================================

describe('useMarketData: needsAuth', () => {
  // All four owner-or-guest endpoints return 401; events (public) returns 200.
  function allGatedDenied() {
    const denied = { status: 401, body: { error: 'Not authenticated' } };
    return mockFetchResponses({
      quotes: denied,
      intraday: denied,
      yesterday: denied,
      movers: denied,
    });
  }

  it('is true for the owner when every gated endpoint answers 401', async () => {
    access.mode = 'owner';
    globalThis.fetch = allGatedDenied() as unknown as typeof fetch;

    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // No gated endpoint succeeded and at least one was denied: the Schwab
    // login behind the owner's session is gone, so the header offers Re-auth.
    expect(result.current.needsAuth).toBe(true);
  });

  it('stays false for a guest whose gated endpoints all answer 401', async () => {
    // needsAuth is the owner's Schwab re-auth prompt (/api/auth/init). A guest
    // has no Schwab login to renew, so the same replies must not raise it.
    access.mode = 'guest';
    globalThis.fetch = allGatedDenied() as unknown as typeof fetch;

    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.needsAuth).toBe(false);
  });

  it('stays false for the owner when one gated endpoint still succeeds', async () => {
    access.mode = 'owner';
    globalThis.fetch = mockFetchResponses({
      quotes: { status: 200, body: mockQuotes },
      intraday: { status: 401, body: { error: 'Not authenticated' } },
      yesterday: { status: 401, body: { error: 'Not authenticated' } },
      movers: { status: 401, body: { error: 'Not authenticated' } },
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.needsAuth).toBe(false);
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
// F1: RETURN IDENTITY STAYS STABLE BETWEEN REAL DATA CHANGES
// ============================================================

describe('useMarketData: F1 return identity', () => {
  it('keeps the same object identity across 15 s of the staleness tick (F1)', async () => {
    // App.tsx's panelMap memo is keyed on this object. A wall-clock tick in
    // the hook used to give it a new identity every 5 s and re-render the
    // whole panel tree ~12 times a minute for the owner. The quote-age clock
    // now lives in useQuoteStaleness (header badge only), so with no new
    // data the identity must hold across the old tick and the 15 s session
    // tick, and before the 60 s quotes poll.
    vi.setSystemTime(REGULAR_HOURS);
    globalThis.fetch = mockFetchResponses({
      quotes: { status: 200, body: { ...mockQuotes, marketOpen: true } },
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.quotesFetchedAt).not.toBeNull());
    const prev = result.current;

    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });

    expect(result.current).toBe(prev);
  });
});

// ============================================================
// FE-STATE-001: QUOTES-SPECIFIC FRESHNESS (quotesFetchedAt)
// ============================================================
//
// The isStale / isVeryStale / staleAgeSec flags moved to useQuoteStaleness
// (F1) and are tested in useQuoteStaleness.test.ts and AppHeader.test.tsx.
// What stays here is their input: quotesFetchedAt tracks the last
// successful /api/quotes fetch only.

describe('useMarketData: FE-STATE-001 quotesFetchedAt', () => {
  const mockQuotesOpen = { ...mockQuotes, marketOpen: true };
  const allUnauthorized = {
    quotes: { status: 401, body: null },
    intraday: { status: 401, body: null },
    yesterday: { status: 401, body: null },
    events: { status: 401, body: null },
    movers: { status: 401, body: null },
  };

  it('quotesFetchedAt is null on initial mount (no fetches yet)', async () => {
    globalThis.fetch = mockFetchResponses() as unknown as typeof fetch;
    const { result } = renderHook(() => useMarketData());
    expect(result.current.quotesFetchedAt).toBeNull();
    // Let the mount fetch settle so the trailing setData/setLoading
    // state updates don't leak past the test boundary and trigger
    // React's "update not wrapped in act" warning.
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it('populates quotesFetchedAt when quotes fetch succeeds', async () => {
    vi.setSystemTime(REGULAR_HOURS);
    globalThis.fetch = mockFetchResponses({
      quotes: { status: 200, body: mockQuotesOpen },
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.quotesFetchedAt).not.toBeNull());
    expect(result.current.quotesFetchedAt).toBe(result.current.fetchedAt);
  });

  it('pins quotesFetchedAt through failing quote polls, then advances on the next quotes success', async () => {
    vi.setSystemTime(REGULAR_HOURS);
    globalThis.fetch = mockFetchResponses({
      quotes: { status: 200, body: mockQuotesOpen },
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.quotesFetchedAt).not.toBeNull());
    const firstFetch = result.current.quotesFetchedAt!;

    // Polls 401 past the 90 s staleness threshold: the badge's input
    // must stay pinned so useQuoteStaleness reports STALE.
    globalThis.fetch = mockFetchResponses(
      allUnauthorized,
    ) as unknown as typeof fetch;
    await act(async () => {
      vi.advanceTimersByTime(95_000);
    });
    expect(result.current.quotesFetchedAt).toBe(firstFetch);

    // Quotes recover: the next poll moves it forward, which clears STALE.
    globalThis.fetch = mockFetchResponses({
      quotes: { status: 200, body: mockQuotesOpen },
    }) as unknown as typeof fetch;
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await waitFor(() =>
      expect(result.current.quotesFetchedAt).toBeGreaterThan(firstFetch),
    );
  });

  it('quote-specific: a fetch where only events/movers succeed sets fetchedAt but not quotesFetchedAt', async () => {
    // Decision 4 "quotes-specific staleness": events/movers freshness must
    // never mask a stale quotes warning.
    vi.setSystemTime(REGULAR_HOURS);
    // Quotes 401 while events + movers (defaults) succeed.
    globalThis.fetch = mockFetchResponses({
      quotes: { status: 401, body: null },
      intraday: { status: 401, body: null },
      yesterday: { status: 401, body: null },
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useMarketData());

    await waitFor(() => expect(result.current.fetchedAt).not.toBeNull());
    expect(result.current.quotesFetchedAt).toBeNull();
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

// ============================================================
// THE OPENING RANGE IS ONLY TODAY'S, AND A NEW ET DAY REFETCHES
// ============================================================
//
// /api/intraday dates the range it returns (`sessionDate`). A tab loaded before
// today's first bar, or held overnight or over a weekend, holds a previous
// session's range with `complete: true`. That must not stop the poll: only
// today's complete range does. And a new ET day refetches every one-shot
// endpoint, which the mount fetch alone would never do for a held tab.

describe('useMarketData: only today’s complete opening range stops the intraday poll', () => {
  const mockQuotesOpen = { ...mockQuotes, marketOpen: true };

  // Thu 2026-04-09 and the sessions around it (EDT, UTC-4).
  const FRIDAY_OPEN = new Date(Date.UTC(2026, 3, 10, 14, 0, 0)); // Fri 10:00 ET
  const MONDAY_930 = new Date(Date.UTC(2026, 3, 13, 13, 30, 0)); // Mon 09:30 ET
  const THURSDAY_2355 = new Date(Date.UTC(2026, 3, 10, 3, 55, 0)); // Thu 23:55 ET

  const heldBody = (sessionDate: string | null, complete: boolean) =>
    ({
      ...mockIntraday,
      sessionDate,
      openingRange: { ...mockIntraday.openingRange, complete },
    }) as unknown as Record<string, unknown>;

  function mockWithIntraday(body: Record<string, unknown>) {
    const fetchMock = mockFetchResponses({
      quotes: {
        status: 200,
        body: mockQuotesOpen as unknown as Record<string, unknown>,
      },
      intraday: { status: 200, body },
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it('re-polls /api/intraday in regular hours when the held complete range is a previous session’s', async () => {
    // Loaded in pre-market with Wednesday's complete range: the server had
    // no bar for today yet, so it answered with the last session's.
    vi.setSystemTime(PRE_MARKET);
    const fetchMock = mockWithIntraday(heldBody('2026-04-08', true));
    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const initialCalls = fetchMock.mock.calls.length;

    // The open arrives: the session tick flips to regular, then the poll.
    vi.setSystemTime(REGULAR_HOURS);
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    expect(result.current.session).toBe('regular');
    await act(async () => {
      vi.advanceTimersByTime(45_000);
    });
    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThan(initialCalls),
    );

    expect(urlsFrom(fetchMock, initialCalls)).toContain('/api/intraday');
  });

  it('does not re-poll /api/intraday once today’s range is complete', async () => {
    vi.setSystemTime(REGULAR_HOURS);
    const fetchMock = mockWithIntraday(heldBody('2026-04-09', true));
    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const initialCalls = fetchMock.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThan(initialCalls),
    );

    const urls = urlsFrom(fetchMock, initialCalls);
    expect(urls).toContain('/api/quotes');
    expect(urls).not.toContain('/api/intraday');
  });

  it('keeps polling /api/intraday while today’s range is still partial', async () => {
    vi.setSystemTime(REGULAR_HOURS);
    const fetchMock = mockWithIntraday(heldBody('2026-04-09', false));
    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const initialCalls = fetchMock.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThan(initialCalls),
    );

    expect(urlsFrom(fetchMock, initialCalls)).toContain('/api/intraday');
  });

  it('re-polls a tab held from Friday into Monday at 9:30 ET, with no re-render in between', async () => {
    // Friday's range was complete and the poll had stopped asking. The date
    // is read when the poll ticks, not when the hook last rendered.
    vi.setSystemTime(FRIDAY_OPEN);
    const fetchMock = mockWithIntraday(heldBody('2026-04-10', true));
    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const initialCalls = fetchMock.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThan(initialCalls),
    );
    // Friday: today's complete range, so no intraday request.
    expect(urlsFrom(fetchMock, initialCalls)).not.toContain('/api/intraday');
    const fridayCalls = fetchMock.mock.calls.length;

    // The laptop wakes on Monday at 9:30 ET, in the same regular session.
    vi.setSystemTime(MONDAY_930);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThan(fridayCalls),
    );

    expect(urlsFrom(fetchMock, fridayCalls)).toContain('/api/intraday');
  });

  describe('crossing ET midnight', () => {
    it('refetches every one-shot endpoint, though the session is closed', async () => {
      vi.setSystemTime(THURSDAY_2355);
      const fetchMock = mockWithIntraday(heldBody('2026-04-09', true));
      const { result } = renderHook(() => useMarketData());
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.session).toBe('closed');
      expect(fetchMock.mock.calls.length).toBe(5);

      // Six minutes later it is Friday 00:01 ET.
      await act(async () => {
        vi.advanceTimersByTime(6 * 60_000);
      });
      await waitFor(() => expect(fetchMock.mock.calls.length).toBe(10));

      // The same five endpoints as the mount fetch made (yesterday's URL
      // carries the ET date, which is the new day's now).
      const endpointsOf = (urls: string[]) =>
        urls.map((url) => url.split('?')[0]).sort();
      expect(endpointsOf(urlsFrom(fetchMock, 5))).toEqual(
        endpointsOf(urlsFrom(fetchMock, 0).slice(0, 5)),
      );
      for (const endpoint of [
        '/api/quotes',
        '/api/intraday',
        '/api/yesterday',
        '/api/events',
        '/api/movers',
      ]) {
        expect(
          urlsFrom(fetchMock, 5).some((url) => url.startsWith(endpoint)),
          endpoint,
        ).toBe(true);
      }
    });

    it('does not refetch before midnight', async () => {
      vi.setSystemTime(THURSDAY_2355);
      const fetchMock = mockWithIntraday(heldBody('2026-04-09', true));
      const { result } = renderHook(() => useMarketData());
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        vi.advanceTimersByTime(3 * 60_000);
      });

      expect(fetchMock.mock.calls.length).toBe(5);
    });

    it('refetches only the events request for a public visitor', async () => {
      access.mode = 'public';
      vi.setSystemTime(THURSDAY_2355);
      const fetchMock = mockWithIntraday(heldBody('2026-04-09', true));
      const { result } = renderHook(() => useMarketData());
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(fetchMock.mock.calls.length).toBe(1);

      await act(async () => {
        vi.advanceTimersByTime(6 * 60_000);
      });
      await waitFor(() => expect(fetchMock.mock.calls.length).toBe(2));

      expect(
        urlsFrom(fetchMock, 0).every((url) => url.startsWith('/api/events')),
      ).toBe(true);
    });
  });
});

// ============================================================
// YESTERDAY IS THE LAST COMPLETED SESSION, ASKED FOR BY ET DATE
// ============================================================
//
// /api/yesterday names the last completed session before today. Served from an
// edge cache a day old, or held by a tab across midnight, it names a day that
// is no longer yesterday (every live row on 2026-11-24 used Friday). The
// request carries the ET date, so a cached body from another day is never
// reused, and the poll asks again while the held day is not the last trading
// day before today (currentYesterday).

describe('useMarketData: yesterday follows the ET date', () => {
  // Thu 2026-04-09 is the date of REGULAR_HOURS and PRE_MARKET; the last
  // trading day before it is Wed 04-08, which is mockYesterday's date.
  const staleYesterday = {
    ...mockYesterday,
    yesterday: { ...mockYesterday.yesterday, date: '2026-04-07' },
  };

  it('asks for /api/yesterday with the ET date of the mount', async () => {
    vi.setSystemTime(REGULAR_HOURS);
    const fetchMock = mockFetchResponses();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(urlsFrom(fetchMock, 0)).toContain('/api/yesterday?d=2026-04-09');
  });

  it('asks again with the new date after ET midnight', async () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 3, 10, 3, 55, 0))); // Thu 23:55 ET
    const fetchMock = mockFetchResponses();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(urlsFrom(fetchMock, 0)).toContain('/api/yesterday?d=2026-04-09');

    await act(async () => {
      vi.advanceTimersByTime(6 * 60_000);
    });
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(10));

    expect(urlsFrom(fetchMock, 5)).toContain('/api/yesterday?d=2026-04-10');
  });

  it('re-polls /api/yesterday while the held day is not the last completed session', async () => {
    vi.setSystemTime(PRE_MARKET);
    const fetchMock = mockFetchResponses({
      yesterday: {
        status: 200,
        body: staleYesterday as unknown as Record<string, unknown>,
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

    expect(urlsFrom(fetchMock, initialCalls)).toContain(
      '/api/yesterday?d=2026-04-09',
    );
  });

  it('heals: the re-poll replaces a stale day, then stops asking', async () => {
    vi.setSystemTime(PRE_MARKET);
    const rest = mockFetchResponses();
    let yesterdayCalls = 0;
    // The first answer is the stale day (a body from a day-old edge cache);
    // the next is the right one.
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (!url.includes('/api/yesterday')) return rest(url, init);
      yesterdayCalls += 1;
      const body = yesterdayCalls === 1 ? staleYesterday : mockYesterday;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data.yesterday?.yesterday?.date).toBe('2026-04-07');

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await waitFor(() =>
      expect(result.current.data.yesterday?.yesterday?.date).toBe('2026-04-08'),
    );
    expect(yesterdayCalls).toBe(2);

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(8),
    );
    expect(yesterdayCalls).toBe(2);
  });

  it('does not re-poll a yesterday that is the last completed session', async () => {
    vi.setSystemTime(PRE_MARKET);
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

    expect(
      urlsFrom(fetchMock, initialCalls).some((url) =>
        url.startsWith('/api/yesterday'),
      ),
    ).toBe(false);
  });

  it('re-polls when Schwab answered with no completed day at all', async () => {
    vi.setSystemTime(PRE_MARKET);
    const fetchMock = mockFetchResponses({
      yesterday: {
        status: 200,
        body: {
          yesterday: null,
          twoDaysAgo: null,
          asOf: '2026-04-09T12:00:00Z',
        },
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

    expect(urlsFrom(fetchMock, initialCalls)).toContain(
      '/api/yesterday?d=2026-04-09',
    );
  });

  it('asks with the date of the tick, for a tab held from Thursday into Friday', async () => {
    // Thursday's yesterday (Wed 04-08) is the right one all day Thursday. On
    // Friday it is a day old, and the poll that finds it so names Friday.
    vi.setSystemTime(REGULAR_HOURS);
    const fetchMock = mockFetchResponses();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const initialCalls = fetchMock.mock.calls.length;

    vi.setSystemTime(new Date(Date.UTC(2026, 3, 10, 14, 0, 0))); // Fri 10:00 ET
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThan(initialCalls),
    );

    expect(urlsFrom(fetchMock, initialCalls)).toContain(
      '/api/yesterday?d=2026-04-10',
    );
  });
});

// ============================================================
// AUD-M16 / AUD-M17 / AUD-M18: failure counting, backoff, fetchedAt contract
// ============================================================

describe('useMarketData: AUD-M16/M17/M18 regressions', () => {
  const mockQuotesOpen = { ...mockQuotes, marketOpen: true };

  // Count how many times the quotes endpoint was hit. During RTH with the
  // default (complete) opening range, each poll fires exactly one quotes
  // request, so this is a clean proxy for "number of polls so far".
  function countQuotesCalls(
    fetchMock: ReturnType<typeof mockFetchResponses>,
  ): number {
    return fetchMock.mock.calls.filter((call: [string, ...unknown[]]) =>
      call[0].includes('/api/quotes'),
    ).length;
  }

  // Advance one 60s window inside act() and return the cumulative number of
  // quotes polls the given mock has received. Flushes the trailing promise
  // microtasks so the poll's async `.then` (which updates the fail counter)
  // settles before we read.
  async function stepAndCount(mock: ReturnType<typeof vi.fn>): Promise<number> {
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    return countQuotesCalls(
      mock as unknown as ReturnType<typeof mockFetchResponses>,
    );
  }

  it('AUD-M16: StrictMode does not double-count poll failures (side effects outside the updater)', async () => {
    // The original bug put the fail-counter increment INSIDE the setData
    // updater. React StrictMode invokes updaters twice in dev, so a single
    // failed fetch bumped the counter twice — crossing the 3-failure backoff
    // threshold in ~half the failures. With the fix the increment lives
    // OUTSIDE the (now-pure) updater, so it advances exactly once per failure
    // even under StrictMode.
    //
    // This is M17's scenario run under StrictMode: a SUCCESSFUL mount (resets
    // the streak, avoiding the mount-failure confound) followed by failing
    // polls. The cadence MUST be identical to the non-Strict M17 case —
    // backoff after exactly THREE failing polls ([1,2,3,3,4,4]). If the
    // increment double-counted, StrictMode would reach the threshold sooner
    // and the cadence would diverge.
    vi.setSystemTime(REGULAR_HOURS);
    const okMock = mockFetchResponses({
      quotes: { status: 200, body: mockQuotesOpen },
    });
    globalThis.fetch = okMock as unknown as typeof fetch;

    const { result } = renderHook(() => useMarketData(), {
      wrapper: StrictWrapper,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Swap in a failing fetch (non-401 → genuine failure) for every poll.
    const failMock = vi.fn(() => Promise.reject(new Error('Network error')));
    globalThis.fetch = failMock as unknown as typeof fetch;

    const counts: number[] = [];
    for (let i = 0; i < 6; i++) counts.push(await stepAndCount(failMock));

    // Identical to M17 (non-Strict): backoff engages after exactly 3 failing
    // polls. A double-count under StrictMode would slow the cadence earlier.
    expect(counts[0]).toBe(1);
    expect(counts[1]).toBe(2);
    expect(counts[2]).toBe(3); // streak now 3 → backoff engages
    expect(counts[3]).toBe(3); // no poll (doubled interval)
    expect(counts[4]).toBe(4); // poll fires
    expect(counts[5]).toBe(4); // no poll
  });

  it('AUD-M17: poll-path failures drive the counter so backoff engages after 3 failures', async () => {
    // Pre-fix, the poll tick never touched the fail counter and the ref read
    // at render never re-rendered, so the documented "interval doubling on
    // 3+ failures" was dead code on the poll path. Here the mount SUCCEEDS
    // (authenticates + starts polling at the 60s cadence) and only the polls
    // fail — exercising exactly the path that was previously inert.
    vi.setSystemTime(REGULAR_HOURS);
    const okMock = mockFetchResponses({
      quotes: { status: 200, body: mockQuotesOpen },
    });
    globalThis.fetch = okMock as unknown as typeof fetch;

    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Swap in a failing fetch (non-401 → genuine failure). All polls now
    // hit this mock, so we count against it.
    const failMock = vi.fn(() => Promise.reject(new Error('Network error')));
    globalThis.fetch = failMock as unknown as typeof fetch;

    const counts: number[] = [];
    for (let i = 0; i < 6; i++) counts.push(await stepAndCount(failMock));

    // Without the fix the poll path never incremented the counter, so the
    // interval would stay at 60s forever and polls would fire EVERY window
    // (1,2,3,4,5,6). With the fix the counter reaches 3 after three failing
    // polls and the interval doubles — polls then fire every OTHER window.
    expect(counts[0]).toBe(1);
    expect(counts[1]).toBe(2);
    expect(counts[2]).toBe(3); // streak now 3 → backoff engages
    expect(counts[3]).toBe(3); // no poll (doubled interval)
    expect(counts[4]).toBe(4); // poll fires
    expect(counts[5]).toBe(4); // no poll
  });

  it('AUD-M18: fetchedAt is unchanged when every poll fetch fails', async () => {
    // Contract: fetchedAt / quotesFetchedAt track the LAST SUCCESSFUL fetch.
    // The original poll path bumped fetchedAt unconditionally inside
    // Promise.all(...).then(), so an all-failed poll moved the freshness
    // timestamp forward and masked a stale feed.
    vi.setSystemTime(REGULAR_HOURS);
    const fetchMock = mockFetchResponses({
      quotes: { status: 200, body: mockQuotesOpen },
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useMarketData());
    await waitFor(() => expect(result.current.fetchedAt).not.toBeNull());

    const fetchedAtBefore = result.current.fetchedAt;
    const quotesFetchedAtBefore = result.current.quotesFetchedAt;
    expect(fetchedAtBefore).not.toBeNull();
    expect(quotesFetchedAtBefore).not.toBeNull();

    // Every subsequent fetch fails outright (network error).
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error('Network error')),
    ) as unknown as typeof fetch;

    // Advance real wall-clock so a fresh `Date.now()` inside the poll would
    // differ from the mount value if it were (wrongly) written.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    // Both freshness timestamps must be pinned to the last SUCCESSFUL fetch.
    expect(result.current.fetchedAt).toBe(fetchedAtBefore);
    expect(result.current.quotesFetchedAt).toBe(quotesFetchedAtBefore);
  });
});

// ============================================================
// ACCESS MODE: A PUBLIC VISITOR MAKES NO OWNER-OR-GUEST REQUEST
// ============================================================
//
// /api/quotes, /api/intraday, /api/yesterday and /api/movers are owner-or-guest;
// /api/events is public. The hook reads the live access mode at render, so a
// test flips `access.mode` and calls `rerender`, as App does when
// useAccessSession reports a change.

describe('useMarketData: access mode', () => {
  // Yesterday's request carries the ET date; every test here pins
  // REGULAR_HOURS, Thu 2026-04-09.
  const GATED_URLS = [
    '/api/quotes',
    '/api/intraday',
    '/api/yesterday?d=2026-04-09',
    '/api/movers',
  ];
  const EVENTS_URL = '/api/events?days=30';
  const eventsBody = {
    events: [],
    startDate: '2026-04-09',
    endDate: '2026-05-09',
    cached: false,
    asOf: '2026-04-09T14:00:00Z',
  };

  type FetchMock = ReturnType<typeof mockFetchResponses>;

  function requestedUrls(fetchMock: { mock: { calls: unknown[][] } }) {
    return fetchMock.mock.calls.map((call) => call[0] as string);
  }

  function gatedUrls(fetchMock: { mock: { calls: unknown[][] } }) {
    return requestedUrls(fetchMock).filter((url) => GATED_URLS.includes(url));
  }

  function quotesCalls(fetchMock: { mock: { calls: unknown[][] } }) {
    return requestedUrls(fetchMock).filter((url) => url === '/api/quotes')
      .length;
  }

  /** Let every promise a render or a timer started run to its end. */
  async function settle() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  /**
   * A fetch that answers only when the test says so. `releases[i]` answers
   * request i with the endpoint's normal reply. With `honoursAbort` an aborted
   * request rejects with an AbortError, as a real fetch does; without it the
   * request ignores the abort and still answers when released.
   */
  function heldFetch({ honoursAbort }: { honoursAbort: boolean }) {
    const reply = mockFetchResponses({
      events: { status: 200, body: eventsBody },
    });
    const releases: Array<() => void> = [];
    const fetchMock = vi.fn(
      (url: string, init?: RequestInit) =>
        new Promise<unknown>((resolve, reject) => {
          releases.push(() => resolve(reply(url, init)));
          if (honoursAbort) {
            init?.signal?.addEventListener(
              'abort',
              () =>
                reject(
                  new DOMException('The operation was aborted.', 'AbortError'),
                ),
              { once: true },
            );
          }
        }),
    );
    return { fetchMock, releases };
  }

  describe('public visitor', () => {
    it('makes one request, to the events endpoint, and none from the poll', async () => {
      access.mode = 'public';
      vi.setSystemTime(REGULAR_HOURS);
      const fetchMock: FetchMock = mockFetchResponses({
        events: { status: 200, body: eventsBody },
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const { result } = renderHook(() => useMarketData());
      expect(result.current.loading).toBe(true);
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(requestedUrls(fetchMock)).toEqual([EVENTS_URL]);
      expect(result.current.data.events).toEqual(eventsBody);
      expect(result.current.hasData).toBe(false);
      expect(result.current.needsAuth).toBe(false);
      expect(result.current.fetchedAt).toBeNull();
      expect(result.current.quotesFetchedAt).toBeNull();

      // A regular session opens the poll gate for a guest. For a public
      // visitor three poll intervals still send nothing.
      expect(result.current.session).toBe('regular');
      await act(async () => {
        vi.advanceTimersByTime(180_000);
      });
      expect(requestedUrls(fetchMock)).toEqual([EVENTS_URL]);
      expect(result.current.fetchedAt).toBeNull();
      expect(result.current.quotesFetchedAt).toBeNull();
    });

    it('leaves events null, stops loading and reports to Sentry when the forward list is malformed', async () => {
      access.mode = 'public';
      const fetchMock = mockFetchResponses({
        events: {
          status: 200,
          body: {
            events: 'nope',
            startDate: eventsBody.startDate,
            endDate: eventsBody.endDate,
          },
        },
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const { result } = renderHook(() => useMarketData());
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(requestedUrls(fetchMock)).toEqual([EVENTS_URL]);
      expect(result.current.data.events).toBeNull();
      expect(mockCaptureUnlessAuth).toHaveBeenCalledTimes(1);
      const [error, options] = mockCaptureUnlessAuth.mock.calls[0]!;
      expect((error as Error).message).toBe(
        'events response failed schema validation',
      );
      expect(options).toMatchObject({
        contexts: {
          events: { request: 'forward', issueCount: expect.any(Number) },
        },
      });
    });

    it('stops loading when the events request fails, and does not retry it', async () => {
      access.mode = 'public';
      vi.setSystemTime(REGULAR_HOURS);
      const fetchMock = mockFetchResponses({
        events: { status: 500, body: { error: 'Internal error' } },
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const { result } = renderHook(() => useMarketData());
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(requestedUrls(fetchMock)).toEqual([EVENTS_URL]);
      expect(result.current.data.events).toBeNull();
      expect(result.current.needsAuth).toBe(false);
      await act(async () => {
        vi.advanceTimersByTime(180_000);
      });
      expect(requestedUrls(fetchMock)).toEqual([EVENTS_URL]);
    });
  });

  describe('signing in without a reload (public to guest)', () => {
    it('fetches each of the five endpoints once, then polls quotes', async () => {
      access.mode = 'public';
      vi.setSystemTime(REGULAR_HOURS);
      const fetchMock = mockFetchResponses({
        events: { status: 200, body: eventsBody },
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const { result, rerender } = renderHook(() => useMarketData());
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(requestedUrls(fetchMock)).toEqual([EVENTS_URL]);

      fetchMock.mockClear();
      access.mode = 'guest';
      rerender();
      await waitFor(() => expect(result.current.hasData).toBe(true));

      expect([...requestedUrls(fetchMock)].sort()).toEqual(
        [...GATED_URLS, EVENTS_URL].sort(),
      );
      expect(result.current.data.quotes).toEqual(mockQuotes);
      expect(result.current.data.yesterday).toEqual(mockYesterday);
      expect(result.current.quotesFetchedAt).not.toBeNull();

      // The poll gate opened with the mode: a minute later quotes refresh.
      fetchMock.mockClear();
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(requestedUrls(fetchMock)).toContain('/api/quotes');
    });
  });

  describe('dropping to public (guest to public)', () => {
    it('sends no owner-or-guest request after the flip, and keeps the loaded data', async () => {
      access.mode = 'guest';
      vi.setSystemTime(REGULAR_HOURS);
      const fetchMock = mockFetchResponses({
        events: { status: 200, body: eventsBody },
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const { result, rerender } = renderHook(() => useMarketData());
      await waitFor(() =>
        expect(result.current.quotesFetchedAt).not.toBeNull(),
      );
      const fetchedAtBefore = result.current.fetchedAt;
      const quotesFetchedAtBefore = result.current.quotesFetchedAt;

      fetchMock.mockClear();
      access.mode = 'public';
      rerender();
      await settle();

      // The flip asks for events alone, then the poll gate stays shut.
      expect(requestedUrls(fetchMock)).toEqual([EVENTS_URL]);
      await act(async () => {
        vi.advanceTimersByTime(180_000);
      });
      expect(gatedUrls(fetchMock)).toEqual([]);
      expect(requestedUrls(fetchMock)).toEqual([EVENTS_URL]);

      // Schwab data already loaded stays (the licensed caches are purged
      // elsewhere), and neither freshness stamp moves.
      expect(result.current.data.quotes).toEqual(mockQuotes);
      expect(result.current.data.intraday).toEqual(mockIntraday);
      expect(result.current.data.yesterday).toEqual(mockYesterday);
      expect(result.current.fetchedAt).toBe(fetchedAtBefore);
      expect(result.current.quotesFetchedAt).toBe(quotesFetchedAtBefore);
    });

    it('reports no market data after the flip, though the quote is still held', async () => {
      // `hasData` is what App reads for "there is market context": it enables
      // the chain fetch, lists the market panels, shows the quote badge, the
      // notification prompt and PreMarketInput. A public visitor gets none of
      // that, so it reads false while public even though `data` keeps the quote.
      access.mode = 'guest';
      globalThis.fetch = mockFetchResponses({
        events: { status: 200, body: eventsBody },
      }) as unknown as typeof fetch;

      const { result, rerender } = renderHook(() => useMarketData());
      await waitFor(() => expect(result.current.hasData).toBe(true));
      expect(result.current.data.quotes).toEqual(mockQuotes);

      access.mode = 'public';
      rerender();
      await settle();

      expect(result.current.hasData).toBe(false);
      expect(result.current.data.quotes).toEqual(mockQuotes);
    });

    it('reports market data again once a guest signs back in and the fan-out lands', async () => {
      access.mode = 'guest';
      globalThis.fetch = mockFetchResponses({
        events: { status: 200, body: eventsBody },
      }) as unknown as typeof fetch;

      const { result, rerender } = renderHook(() => useMarketData());
      await waitFor(() => expect(result.current.hasData).toBe(true));

      access.mode = 'public';
      rerender();
      await settle();
      expect(result.current.hasData).toBe(false);

      // The next sign-in's quote is a different one: the fan-out replaced it.
      const newerQuotes = {
        ...mockQuotes,
        spx: { ...mockQuotes.spx, price: 7001 },
      };
      globalThis.fetch = mockFetchResponses({
        quotes: { status: 200, body: newerQuotes },
        events: { status: 200, body: eventsBody },
      }) as unknown as typeof fetch;
      access.mode = 'guest';
      rerender();
      await waitFor(() =>
        expect(result.current.data.quotes?.spx?.price).toBe(7001),
      );

      expect(result.current.hasData).toBe(true);
    });

    it('reads needsAuth as false after the flip, though the owner had it true', async () => {
      access.mode = 'owner';
      const denied = { status: 401, body: { error: 'Not authenticated' } };
      globalThis.fetch = mockFetchResponses({
        quotes: denied,
        intraday: denied,
        yesterday: denied,
        movers: denied,
      }) as unknown as typeof fetch;

      const { result, rerender } = renderHook(() => useMarketData());
      await waitFor(() => expect(result.current.needsAuth).toBe(true));

      access.mode = 'public';
      rerender();
      await settle();

      expect(result.current.needsAuth).toBe(false);
    });

    it.each([
      ['honours the abort', true],
      ['ignores the abort and answers late', false],
    ])(
      'writes nothing from a mount fetch still in flight at the flip, whose request %s',
      async (_name, honoursAbort) => {
        access.mode = 'guest';
        const { fetchMock, releases } = heldFetch({ honoursAbort });
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const { result, rerender } = renderHook(() => useMarketData());
        expect(fetchMock).toHaveBeenCalledTimes(5);
        const mountSignals = fetchMock.mock.calls.map(
          (call) => call[1]?.signal,
        );
        expect(mountSignals.every((signal) => signal?.aborted === false)).toBe(
          true,
        );

        access.mode = 'public';
        rerender();

        // The effect run that sent the five requests aborted all of them, and
        // the public run sent events alone.
        expect(mountSignals.every((signal) => signal?.aborted === true)).toBe(
          true,
        );
        expect(requestedUrls(fetchMock).slice(5)).toEqual([EVENTS_URL]);

        // The five mount requests answer now. An aborted fetch has already
        // rejected, so only the abort-ignoring mock delivers a reply.
        for (const release of releases.slice(0, 5)) release();
        await settle();

        expect(result.current.data.quotes).toBeNull();
        expect(result.current.data.intraday).toBeNull();
        expect(result.current.data.yesterday).toBeNull();
        expect(result.current.data.movers).toBeNull();
        expect(result.current.data.events).toBeNull();
        expect(result.current.hasData).toBe(false);
        expect(result.current.fetchedAt).toBeNull();
        expect(result.current.quotesFetchedAt).toBeNull();
        // Still waiting for the public run's own events reply: nothing a
        // late mount reply did ended the loading state.
        expect(result.current.loading).toBe(true);

        releases[5]!();
        await settle();
        expect(result.current.loading).toBe(false);
        expect(result.current.data.events).toEqual(eventsBody);
        expect(result.current.data.quotes).toBeNull();
      },
    );

    it('ends loading and writes nothing else from a mount reply that lands once the mode is public but before the rerender', async () => {
      // The cookie went public and App has not re-rendered the hook yet (an
      // expiry or a manual clear sends no notification), so the effect's
      // cleanup has not aborted the run. The reply reads the live mode itself.
      access.mode = 'guest';
      const { fetchMock, releases } = heldFetch({ honoursAbort: false });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const { result, rerender } = renderHook(() => useMarketData());
      expect(fetchMock).toHaveBeenCalledTimes(5);

      access.mode = 'public';
      for (const release of releases) release();
      await settle();

      expect(result.current.data.quotes).toBeNull();
      expect(result.current.data.intraday).toBeNull();
      expect(result.current.data.yesterday).toBeNull();
      expect(result.current.data.movers).toBeNull();
      expect(result.current.data.events).toBeNull();
      expect(result.current.hasData).toBe(false);
      expect(result.current.needsAuth).toBe(false);
      expect(result.current.fetchedAt).toBeNull();
      expect(result.current.quotesFetchedAt).toBeNull();
      // Nothing would re-render the hook to end the wait, so the reply ends it
      // itself: the visitor can no longer use the data, but must not be left
      // loading.
      expect(result.current.loading).toBe(false);

      // The next render sees the public mode and sends the events request;
      // its reply stores events and leaves everything else as it was.
      rerender();
      expect(requestedUrls(fetchMock).slice(5)).toEqual([EVENTS_URL]);
      releases[5]!();
      await settle();

      expect(result.current.loading).toBe(false);
      expect(result.current.data.events).toEqual(eventsBody);
      expect(result.current.data.quotes).toBeNull();
      expect(result.current.fetchedAt).toBeNull();
    });

    it('writes nothing from a poll reply that lands after the flip', async () => {
      access.mode = 'guest';
      vi.setSystemTime(REGULAR_HOURS);
      const normal = mockFetchResponses();
      globalThis.fetch = normal as unknown as typeof fetch;

      const { result, rerender } = renderHook(() => useMarketData());
      await waitFor(() =>
        expect(result.current.quotesFetchedAt).not.toBeNull(),
      );
      const fetchedAtBefore = result.current.fetchedAt;
      const quotesFetchedAtBefore = result.current.quotesFetchedAt;

      // The next quotes poll is held open; every other request answers.
      let answerQuotes: (reply: unknown) => void = () => {};
      globalThis.fetch = vi.fn((url: string, init?: RequestInit) =>
        url === '/api/quotes'
          ? new Promise((resolve) => {
              answerQuotes = resolve;
            })
          : normal(url, init),
      ) as unknown as typeof fetch;
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(quotesCalls(vi.mocked(globalThis.fetch))).toBe(1);

      access.mode = 'public';
      rerender();
      await settle();

      // The reply arrives after the flip, carrying a new SPX price.
      answerQuotes({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            ...mockQuotes,
            spx: { ...mockQuotes.spx, price: 7001 },
          }),
      });
      await settle();

      expect(result.current.data.quotes).toEqual(mockQuotes);
      expect(result.current.fetchedAt).toBe(fetchedAtBefore);
      expect(result.current.quotesFetchedAt).toBe(quotesFetchedAtBefore);
    });
  });

  describe('request lifecycle', () => {
    it.each<AccessMode>(['owner', 'guest', 'public'])(
      'makes no new request when a %s visitor rerenders in the same mode',
      async (mode) => {
        access.mode = mode;
        vi.setSystemTime(REGULAR_HOURS);
        const fetchMock = mockFetchResponses();
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const { result, rerender } = renderHook(() => useMarketData());
        await waitFor(() => expect(result.current.loading).toBe(false));
        const callsAfterMount = fetchMock.mock.calls.length;
        expect(callsAfterMount).toBe(mode === 'public' ? 1 : 5);

        rerender();
        rerender();
        await settle();

        expect(fetchMock.mock.calls.length).toBe(callsAfterMount);
      },
    );

    it('aborts its in-flight requests on unmount', async () => {
      access.mode = 'guest';
      const { fetchMock } = heldFetch({ honoursAbort: false });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const { unmount } = renderHook(() => useMarketData());
      const signals = fetchMock.mock.calls.map((call) => call[1]?.signal);
      expect(signals).toHaveLength(5);
      expect(signals.every((signal) => signal?.aborted === false)).toBe(true);

      unmount();

      expect(signals.every((signal) => signal?.aborted === true)).toBe(true);
    });
  });

  describe('consecutive-failure streak', () => {
    // A poll that fails (not a 401) adds one to the streak; three in a row
    // double the interval to two minutes. These tests read the streak through
    // that cadence: with the streak at 1 the next poll comes after 60 s, at 3
    // it does not.

    it('is not moved by a public visitor whose events request fails', async () => {
      vi.setSystemTime(REGULAR_HOURS);
      const failing = vi.fn(() => Promise.reject(new Error('Network error')));
      globalThis.fetch = failing as unknown as typeof fetch;

      // A guest mount in which all five requests fail: streak 1.
      access.mode = 'guest';
      const { result, rerender } = renderHook(() => useMarketData());
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(failing).toHaveBeenCalledTimes(5);

      // A public stretch whose only request fails too.
      access.mode = 'public';
      rerender();
      await settle();
      expect(failing).toHaveBeenCalledTimes(6);

      // Back to a guest, whose five requests fail again: streak 2, not 3.
      access.mode = 'guest';
      rerender();
      await settle();
      expect(failing).toHaveBeenCalledTimes(11);

      // At a streak of 2 the poll still comes after 60 s.
      failing.mockClear();
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(quotesCalls(failing)).toBe(1);
    });

    it('is not moved by a mount fetch the flip aborted', async () => {
      vi.setSystemTime(REGULAR_HOURS);
      // Every request hangs until the hook aborts it. fetchJson turns that
      // abort into `{ status: 0 }`, which a hook that read it would count as
      // a failure.
      const { fetchMock: hanging } = heldFetch({ honoursAbort: true });
      globalThis.fetch = hanging as unknown as typeof fetch;

      access.mode = 'guest';
      const { result, rerender } = renderHook(() => useMarketData());
      // The first guest mount is aborted by the flip to public, and so is the
      // second, which that flip back to guest started.
      for (let i = 0; i < 2; i++) {
        access.mode = 'public';
        rerender();
        await settle();
        access.mode = 'guest';
        rerender();
        await settle();
      }
      expect(result.current.loading).toBe(true);

      // The third guest mount is aborted too, and the fourth has replies:
      // they are plain failures, one counted failure in all.
      const failing = vi.fn(() => Promise.reject(new Error('Network error')));
      globalThis.fetch = failing as unknown as typeof fetch;
      access.mode = 'public';
      rerender();
      await settle();
      access.mode = 'guest';
      rerender();
      await settle();
      await waitFor(() => expect(result.current.loading).toBe(false));

      // One counted failure, not four: the poll still comes after 60 s.
      failing.mockClear();
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(quotesCalls(failing)).toBe(1);
    });

    it('is not moved by a poll failure that lands after the flip', async () => {
      vi.setSystemTime(REGULAR_HOURS);
      // A guest mount whose five requests fail outright: streak 1.
      const failing = vi.fn(() => Promise.reject(new Error('Network error')));
      globalThis.fetch = failing as unknown as typeof fetch;
      access.mode = 'guest';
      const { result, rerender } = renderHook(() => useMarketData());
      await waitFor(() => expect(result.current.loading).toBe(false));

      // The next poll's requests are held open.
      const failHeld: Array<(error: Error) => void> = [];
      globalThis.fetch = vi.fn(
        () =>
          new Promise((_resolve, reject) => {
            failHeld.push(reject);
          }),
      ) as unknown as typeof fetch;
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(failHeld.length).toBeGreaterThan(0);

      // The visitor drops to public, then the held poll fails. That reply
      // writes nothing, so it adds nothing to the streak.
      access.mode = 'public';
      rerender();
      for (const fail of failHeld) fail(new Error('Network error'));
      await settle();

      // Back to a guest whose five requests fail again: streak 2, not 3.
      failing.mockClear();
      globalThis.fetch = failing as unknown as typeof fetch;
      access.mode = 'guest';
      rerender();
      await settle();
      expect(failing).toHaveBeenCalledTimes(5);

      failing.mockClear();
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(quotesCalls(failing)).toBe(1);
    });
  });
});
