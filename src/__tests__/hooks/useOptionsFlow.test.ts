import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useOptionsFlow } from '../../hooks/useOptionsFlow';
import type {
  RankedStrike,
  DirectionalRollup,
} from '../../hooks/useOptionsFlow';

// ============================================================
// MOCK DATA
// ============================================================

function makeStrike(overrides: Partial<RankedStrike> = {}): RankedStrike {
  return {
    strike: 5700,
    type: 'call',
    distance_from_spot: 20,
    distance_pct: 0.0035,
    total_premium: 1_250_000,
    ask_side_ratio: 0.72,
    volume_oi_ratio: 1.4,
    hit_count: 3,
    has_ascending_fill: true,
    has_descending_fill: false,
    has_multileg: false,
    is_itm: false,
    score: 92.5,
    first_seen_at: '2026-04-14T14:30:00Z',
    last_seen_at: '2026-04-14T14:40:00Z',
    ...overrides,
  };
}

function makeRollup(
  overrides: Partial<DirectionalRollup> = {},
): DirectionalRollup {
  return {
    bullish_count: 3,
    bearish_count: 1,
    bullish_premium: 4_000_000,
    bearish_premium: 500_000,
    lean: 'bullish',
    confidence: 0.88,
    top_bullish_strike: 5720,
    top_bearish_strike: 5650,
    ...overrides,
  };
}

// API response is snake_case
function makeApiResponse(overrides: Record<string, unknown> = {}) {
  return {
    strikes: [makeStrike()],
    rollup: makeRollup(),
    spot: 5680,
    window_minutes: 15,
    last_updated: '2026-04-14T14:40:00Z',
    alert_count: 42,
    timestamps: ['2026-04-14T14:30:00Z', '2026-04-14T14:40:00Z'],
    ...overrides,
  };
}

// ============================================================
// HELPERS
// ============================================================

interface MockFetchOptions {
  ok?: boolean;
  status?: number;
  body?: unknown;
}

function buildResponse(opts: MockFetchOptions = {}) {
  const status = opts.status ?? 200;
  return {
    ok: opts.ok ?? (status >= 200 && status < 300),
    status,
    json: () => Promise.resolve(opts.body ?? makeApiResponse()),
  };
}

// ============================================================
// LIFECYCLE
// ============================================================

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fetchMock = vi.fn(() => Promise.resolve(buildResponse()));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ============================================================
// TESTS
// ============================================================

describe('useOptionsFlow', () => {
  it('does not fetch when marketOpen is false', async () => {
    const { result } = renderHook(() => useOptionsFlow({ marketOpen: false }));

    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.data).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.lastFetchedAt).toBeNull();
  });

  it('fetches on mount when marketOpen=true with default params', async () => {
    const { result } = renderHook(() => useOptionsFlow({ marketOpen: true }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('/api/options-flow/top-strikes');
    expect(calledUrl).toContain('limit=10');
    expect(calledUrl).toContain('window_minutes=15');

    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });

  it('populates data with camelCase mapping on successful response', async () => {
    const apiBody = makeApiResponse({
      spot: 5700,
      window_minutes: 30,
      last_updated: '2026-04-14T15:00:00Z',
      alert_count: 99,
    });
    fetchMock.mockResolvedValue(buildResponse({ body: apiBody }));

    const { result } = renderHook(() =>
      useOptionsFlow({ marketOpen: true, windowMinutes: 30 }),
    );

    await waitFor(() => expect(result.current.data).not.toBeNull());

    expect(result.current.data?.spot).toBe(5700);
    expect(result.current.data?.windowMinutes).toBe(30);
    expect(result.current.data?.lastUpdated).toBe('2026-04-14T15:00:00Z');
    expect(result.current.data?.alertCount).toBe(99);
    expect(result.current.data?.strikes).toHaveLength(1);
    expect(result.current.data?.rollup.lean).toBe('bullish');
    expect(result.current.error).toBeNull();
    expect(result.current.lastFetchedAt).toBeInstanceOf(Date);
  });

  it('uses custom limit and windowMinutes in query string', async () => {
    renderHook(() =>
      useOptionsFlow({ marketOpen: true, limit: 5, windowMinutes: 30 }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('limit=5');
    expect(calledUrl).toContain('window_minutes=30');
  });

  it('sets error on fetch failure but preserves previous data', async () => {
    // First call succeeds
    fetchMock.mockResolvedValueOnce(buildResponse());
    // Second call fails with 500
    fetchMock.mockResolvedValueOnce(buildResponse({ status: 500 }));

    const { result } = renderHook(() => useOptionsFlow({ marketOpen: true }));

    // Wait for first fetch to populate data
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.error).toBeNull();

    // Advance to next poll (default 60s)
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    // Error should be set but data preserved
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.data).not.toBeNull();
    expect(result.current.data?.alertCount).toBe(42);
  });

  it('polls at the configured interval while marketOpen=true', async () => {
    renderHook(() =>
      useOptionsFlow({ marketOpen: true, pollIntervalMs: 10_000 }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  it('stops polling when marketOpen flips to false and preserves data', async () => {
    const { result, rerender } = renderHook(
      ({ marketOpen }: { marketOpen: boolean }) =>
        useOptionsFlow({ marketOpen, pollIntervalMs: 10_000 }),
      { initialProps: { marketOpen: true } },
    );

    await waitFor(() => expect(result.current.data).not.toBeNull());
    const callsWhileOpen = fetchMock.mock.calls.length;
    expect(callsWhileOpen).toBe(1);

    // Flip to closed
    rerender({ marketOpen: false });

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    // No additional fetches after closing
    expect(fetchMock.mock.calls.length).toBe(callsWhileOpen);
    // Data still present
    expect(result.current.data).not.toBeNull();
  });

  it('resumes polling with an immediate fetch when marketOpen flips back to true', async () => {
    const { result, rerender } = renderHook(
      ({ marketOpen }: { marketOpen: boolean }) =>
        useOptionsFlow({ marketOpen, pollIntervalMs: 10_000 }),
      { initialProps: { marketOpen: false } },
    );

    // No fetch initially
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // Flip to open — should fetch immediately
    rerender({ marketOpen: true });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.data).not.toBeNull());

    // And continues polling
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('cleans up interval and aborts in-flight request on unmount', async () => {
    const { result, unmount } = renderHook(() =>
      useOptionsFlow({ marketOpen: true, pollIntervalMs: 10_000 }),
    );

    await waitFor(() => expect(result.current.data).not.toBeNull());
    const callsAfterMount = fetchMock.mock.calls.length;

    unmount();

    // Advance well past the poll interval
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    // No new fetches after unmount
    expect(fetchMock.mock.calls.length).toBe(callsAfterMount);
  });

  it('does not update state when fetch resolves after unmount', async () => {
    // Hold the fetch promise open so we can resolve it post-unmount.
    let resolveFetch: (value: unknown) => void = () => {};
    const pending = new Promise<unknown>((resolve) => {
      resolveFetch = resolve;
    });
    fetchMock.mockReturnValueOnce(pending);

    const { result, unmount } = renderHook(() =>
      useOptionsFlow({ marketOpen: true }),
    );

    // Unmount before the fetch resolves.
    unmount();

    // Now resolve the pending fetch — should be ignored.
    resolveFetch(buildResponse());
    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    // Data should remain null; no late setState fired.
    expect(result.current.data).toBeNull();
  });

  it('does not set error state on AbortError', async () => {
    // Simulate an AbortError (what the AbortController produces).
    const abortError = new DOMException(
      'The operation was aborted.',
      'AbortError',
    );
    fetchMock.mockRejectedValueOnce(abortError);

    const { result } = renderHook(() => useOptionsFlow({ marketOpen: true }));

    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    // No error surfaced for AbortError
    expect(result.current.error).toBeNull();
    expect(result.current.data).toBeNull();
  });
});
