/**
 * Unit tests for usePeriscopeStrikes.
 *
 * Mocks global fetch + getAccessMode so the hook can be exercised
 * without a network round-trip. The lookback-walking logic
 * (latest + 1/2/3 slots back) is the load-bearing piece — most cases
 * here pin that contract.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { mockGetAccessMode } = vi.hoisted(() => ({
  mockGetAccessMode: vi.fn(),
}));

vi.mock('../../utils/auth', () => ({
  getAccessMode: mockGetAccessMode,
}));

import {
  usePeriscopeStrikes,
  type PeriscopeStrikesResponse,
} from '../../hooks/usePeriscopeStrikes';

function makeResponse(
  overrides: Partial<PeriscopeStrikesResponse> = {},
): PeriscopeStrikesResponse {
  return {
    marketOpen: true,
    asOf: '2026-05-12T18:45:00.000Z',
    capturedAt: '2026-05-12T18:40:00.000Z',
    priorCapturedAt: '2026-05-12T18:30:00.000Z',
    spot: 7340,
    strikes: [
      { strike: 7350, gamma: 5000, charm: -400000 },
      { strike: 7375, gamma: 3000, charm: 33000 },
    ],
    availableSlots: [
      '2026-05-12T18:10:00.000Z',
      '2026-05-12T18:20:00.000Z',
      '2026-05-12T18:30:00.000Z',
      '2026-05-12T18:40:00.000Z',
    ],
    ...overrides,
  };
}

function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      return handler(url);
    }),
  );
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  mockGetAccessMode.mockReturnValue('owner');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // Belt-and-suspenders: if a test left fake timers running (e.g. it
  // threw before its own try/finally restored them), reset here so the
  // shared vitest worker doesn't poison sibling test files.
  vi.useRealTimers();
});

describe('usePeriscopeStrikes', () => {
  it('fetches latest + 10m/30m lookbacks and builds gamma maps', async () => {
    const calls: string[] = [];
    mockFetch((url) => {
      calls.push(url);
      // First call (no `?time`): latest.
      if (!url.includes('time=')) return jsonResponse(makeResponse());
      // Lookback calls — return distinct gamma values per slot so the
      // delta map keying is verifiable.
      if (url.includes('time=13%3A30') || url.includes('time=13:30'))
        return jsonResponse(
          makeResponse({
            capturedAt: '2026-05-12T18:30:00.000Z',
            strikes: [{ strike: 7350, gamma: 4500, charm: 0 }],
          }),
        );
      if (url.includes('time=13%3A10') || url.includes('time=13:10'))
        return jsonResponse(
          makeResponse({
            capturedAt: '2026-05-12T18:10:00.000Z',
            strikes: [{ strike: 7350, gamma: 3500, charm: 0 }],
          }),
        );
      return jsonResponse(makeResponse());
    });

    const { result } = renderHook(() =>
      usePeriscopeStrikes(false, '2026-05-12'),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.latest?.capturedAt).toBe('2026-05-12T18:40:00.000Z');
    expect(result.current.prior10m?.get(7350)).toBe(4500);
    expect(result.current.prior30m?.get(7350)).toBe(3500);
    expect(result.current.error).toBeNull();
    // 3 HTTP calls — primary + 10m + 30m. 20m intentionally skipped
    // (no Phase 2 consumer; Phase 3 adds it back).
    expect(calls).toHaveLength(3);
  });

  it('returns null 30m lookback when not enough history exists', async () => {
    mockFetch((url) => {
      // Only two slots in availableSlots — only 10m lookback is reachable.
      if (!url.includes('time=')) {
        return jsonResponse(
          makeResponse({
            availableSlots: [
              '2026-05-12T18:30:00.000Z',
              '2026-05-12T18:40:00.000Z',
            ],
          }),
        );
      }
      return jsonResponse(
        makeResponse({
          capturedAt: '2026-05-12T18:30:00.000Z',
          strikes: [{ strike: 7350, gamma: 4500, charm: 0 }],
        }),
      );
    });

    const { result } = renderHook(() =>
      usePeriscopeStrikes(false, '2026-05-12'),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.prior10m?.get(7350)).toBe(4500);
    expect(result.current.prior30m).toBeNull();
  });

  it('stays idle in public access mode (no fetch fired)', async () => {
    mockGetAccessMode.mockReturnValue('public');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { result } = renderHook(() =>
      usePeriscopeStrikes(false, '2026-05-12'),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.latest).toBeNull();
  });

  it('surfaces an error message when fetch rejects', async () => {
    mockFetch(() => {
      throw new Error('network down');
    });

    const { result } = renderHook(() =>
      usePeriscopeStrikes(false, '2026-05-12'),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain('network down');
    expect(result.current.latest).toBeNull();
  });

  it('returns null latest on 401 without surfacing an error', async () => {
    mockFetch(() => new Response('', { status: 401 }));

    const { result } = renderHook(() =>
      usePeriscopeStrikes(false, '2026-05-12'),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.latest).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('does NOT fetch lookbacks when latest has no capturedAt (empty slot)', async () => {
    const calls: string[] = [];
    mockFetch((url) => {
      calls.push(url);
      return jsonResponse(
        makeResponse({
          capturedAt: null,
          priorCapturedAt: null,
          strikes: [],
          availableSlots: [],
        }),
      );
    });

    const { result } = renderHook(() =>
      usePeriscopeStrikes(false, '2026-05-12'),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.prior10m).toBeNull();
    expect(result.current.prior30m).toBeNull();
    // Only the primary fetch — no lookback round-trips.
    expect(calls).toHaveLength(1);
  });

  it('short-circuits when capturedAt is not present in availableSlots', async () => {
    // Defensive case: capturedAt missing from availableSlots means
    // indexOf returns -1, so no lookback slot can be computed. The
    // short-circuit must skip the .map() entirely — no lookback HTTP
    // calls fire. We pin this by asserting NO request URL carries a
    // `time=` param (the primary fetch only uses `date=`; lookback
    // fetches always include `time=`). The total-call-count assertion
    // alone is not enough — even without the outer short-circuit, the
    // per-index `idx < 0` guard would still suppress the fetches.
    const calls: string[] = [];
    mockFetch((url) => {
      calls.push(url);
      return jsonResponse(
        makeResponse({
          capturedAt: '2026-05-12T18:40:00.000Z',
          // capturedAt deliberately absent from availableSlots
          availableSlots: [
            '2026-05-12T18:10:00.000Z',
            '2026-05-12T18:20:00.000Z',
            '2026-05-12T18:30:00.000Z',
          ],
        }),
      );
    });

    const { result } = renderHook(() =>
      usePeriscopeStrikes(false, '2026-05-12'),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.prior10m).toBeNull();
    expect(result.current.prior30m).toBeNull();
    expect(calls).toHaveLength(1);
    // No URL carries `time=` — confirms no lookback fetches fired.
    expect(calls.some((u) => u.includes('time='))).toBe(false);
  });

  it('does NOT poll when in snapshot mode (at param set)', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn(async () => jsonResponse(makeResponse()));
    vi.stubGlobal('fetch', fetchSpy);

    try {
      renderHook(() =>
        usePeriscopeStrikes(true, '2026-05-12', '2026-05-12T18:40:00.000Z'),
      );
      // Let the initial async fetch settle.
      await vi.runOnlyPendingTimersAsync();
      // Advance well past the poll interval — no second fetch should fire.
      await vi.advanceTimersByTimeAsync(120_000);
      // 3 calls total = 1 primary + 10m + 30m lookbacks. No polling
      // = no 4th call. (20m intentionally not fetched in Phase 2.)
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts the in-flight request on unmount', async () => {
    const aborts: AbortSignal[] = [];
    // Direct stubGlobal with both args so we can capture `init.signal`
    // — the helper `mockFetch` above only forwards the URL.
    const stub = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.signal) aborts.push(init.signal);
        // Never resolves — request stays in-flight until aborted.
        return new Promise<Response>(() => {});
      },
    );
    vi.stubGlobal('fetch', stub);

    const { unmount } = renderHook(() =>
      usePeriscopeStrikes(true, '2026-05-12'),
    );
    await waitFor(() => expect(stub).toHaveBeenCalled());
    expect(aborts[0]?.aborted).toBe(false);

    unmount();
    expect(aborts[0]?.aborted).toBe(true);
  });

  it('aborts the in-flight request when the date prop changes mid-flight', async () => {
    const aborts: AbortSignal[] = [];
    let callCount = 0;
    // First date: requests hang until aborted (so we capture the signals).
    // Second date: requests resolve immediately so the new fetch completes.
    const stub = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        callCount += 1;
        if (init?.signal) aborts.push(init.signal);
        // First 3 calls (initial latest + 2 lookbacks for date #1) hang.
        if (callCount <= 3) {
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          });
        }
        // Subsequent calls for date #2 resolve cleanly.
        return jsonResponse(makeResponse());
      },
    );
    vi.stubGlobal('fetch', stub);

    const { rerender } = renderHook(
      ({ d }: { d: string }) => usePeriscopeStrikes(true, d),
      { initialProps: { d: '2026-05-12' } },
    );
    await waitFor(() => expect(stub).toHaveBeenCalled());
    expect(aborts[0]?.aborted).toBe(false);

    rerender({ d: '2026-05-13' });
    await waitFor(() => expect(aborts[0]?.aborted).toBe(true));
  });
});
