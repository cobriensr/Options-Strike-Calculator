import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useWhalePositioning } from '../../hooks/useWhalePositioning';
import type { WhaleAlert } from '../../types/flow';

// ============================================================
// MOCK DATA
// ============================================================

function makeAlert(overrides: Partial<WhaleAlert> = {}): WhaleAlert {
  return {
    option_chain: 'SPXW 2026-04-20 C5700',
    strike: 5700,
    type: 'call',
    expiry: '2026-04-20',
    dte_at_alert: 5,
    created_at: '2026-04-14T14:30:00Z',
    age_minutes: 15,
    total_premium: 2_500_000,
    total_ask_side_prem: 2_300_000,
    total_bid_side_prem: 200_000,
    ask_side_ratio: 0.92,
    total_size: 5000,
    volume: 6000,
    open_interest: 1200,
    volume_oi_ratio: 5.0,
    has_sweep: false,
    has_floor: false,
    has_multileg: false,
    alert_rule: 'RepeatedHits',
    underlying_price: 5680,
    distance_from_spot: 20,
    distance_pct: 0.0035,
    is_itm: false,
    ...overrides,
  };
}

function makeApiResponse(overrides: Record<string, unknown> = {}) {
  return {
    strikes: [makeAlert()],
    total_premium: 2_500_000,
    alert_count: 1,
    last_updated: '2026-04-14T14:30:00Z',
    spot: 5680,
    window_minutes: 390,
    min_premium: 1_000_000,
    max_dte: 7,
    timestamps: ['2026-04-14T14:00:00Z', '2026-04-14T14:30:00Z'],
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

describe('useWhalePositioning', () => {
  it('fetches on mount with the correct URL and default query params', async () => {
    const { result } = renderHook(() =>
      useWhalePositioning({ marketOpen: true }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('/api/options-flow/whale-positioning');
    expect(calledUrl).toContain('min_premium=500000');
    expect(calledUrl).toContain('max_dte=7');
    expect(calledUrl).toContain('limit=20');

    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });

  it('populates data with camelCase mapping on successful response', async () => {
    const apiBody = makeApiResponse({
      spot: 5800,
      window_minutes: 400,
      last_updated: '2026-04-14T15:00:00Z',
      alert_count: 7,
      total_premium: 18_500_000,
      min_premium: 1_000_000,
      max_dte: 7,
    });
    fetchMock.mockResolvedValue(buildResponse({ body: apiBody }));

    const { result } = renderHook(() =>
      useWhalePositioning({ marketOpen: true }),
    );

    await waitFor(() => expect(result.current.data).not.toBeNull());

    expect(result.current.data?.spot).toBe(5800);
    expect(result.current.data?.windowMinutes).toBe(400);
    expect(result.current.data?.lastUpdated).toBe('2026-04-14T15:00:00Z');
    expect(result.current.data?.alertCount).toBe(7);
    expect(result.current.data?.totalPremium).toBe(18_500_000);
    expect(result.current.data?.minPremium).toBe(1_000_000);
    expect(result.current.data?.maxDte).toBe(7);
    expect(result.current.data?.strikes).toHaveLength(1);
    expect(result.current.error).toBeNull();
    expect(result.current.lastFetchedAt).toBeInstanceOf(Date);
  });

  it('uses custom minPremium, maxDte, and limit in the query string', async () => {
    renderHook(() =>
      useWhalePositioning({
        marketOpen: true,
        minPremium: 500_000,
        maxDte: 14,
        limit: 50,
      }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('min_premium=500000');
    expect(calledUrl).toContain('max_dte=14');
    expect(calledUrl).toContain('limit=50');
  });

  it('polls at the configured interval while marketOpen=true', async () => {
    renderHook(() =>
      useWhalePositioning({ marketOpen: true, pollIntervalMs: 10_000 }),
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

  it('fetches once but does not poll when marketOpen=false', async () => {
    renderHook(() =>
      useWhalePositioning({ marketOpen: false, pollIntervalMs: 10_000 }),
    );

    // Initial fetch still happens (post-session review use case).
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Advance well past multiple intervals — no further fetches.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sets error on fetch failure but preserves previous data', async () => {
    fetchMock.mockResolvedValueOnce(buildResponse());
    fetchMock.mockResolvedValueOnce(buildResponse({ status: 500 }));

    const { result } = renderHook(() =>
      useWhalePositioning({ marketOpen: true, pollIntervalMs: 10_000 }),
    );

    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.error).toBeNull();
    const firstAlertCount = result.current.data?.alertCount;

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });

    await waitFor(() => expect(result.current.error).not.toBeNull());
    // Data preserved
    expect(result.current.data).not.toBeNull();
    expect(result.current.data?.alertCount).toBe(firstAlertCount);
  });

  it('cleans up interval and aborts in-flight request on unmount', async () => {
    const { result, unmount } = renderHook(() =>
      useWhalePositioning({ marketOpen: true, pollIntervalMs: 10_000 }),
    );

    await waitFor(() => expect(result.current.data).not.toBeNull());
    const callsAfterMount = fetchMock.mock.calls.length;

    unmount();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    expect(fetchMock.mock.calls.length).toBe(callsAfterMount);
  });

  it('does not update state when fetch resolves after unmount', async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    const pending = new Promise<unknown>((resolve) => {
      resolveFetch = resolve;
    });
    fetchMock.mockReturnValueOnce(pending);

    const { result, unmount } = renderHook(() =>
      useWhalePositioning({ marketOpen: true }),
    );

    unmount();

    resolveFetch(buildResponse());
    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    expect(result.current.data).toBeNull();
  });

  it('does not set error state on AbortError', async () => {
    const abortError = new DOMException(
      'The operation was aborted.',
      'AbortError',
    );
    fetchMock.mockRejectedValueOnce(abortError);

    const { result } = renderHook(() =>
      useWhalePositioning({ marketOpen: true }),
    );

    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    expect(result.current.error).toBeNull();
    expect(result.current.data).toBeNull();
  });

  it('parses timestamps from the API response', async () => {
    const ts = ['2026-04-14T14:00:00Z', '2026-04-14T14:30:00Z'];
    fetchMock.mockResolvedValue(
      buildResponse({ body: makeApiResponse({ timestamps: ts }) }),
    );

    const { result } = renderHook(() =>
      useWhalePositioning({ marketOpen: true }),
    );

    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data?.timestamps).toEqual(ts);
  });

  it('passes selectedDate as ?date= query param', async () => {
    renderHook(() =>
      useWhalePositioning({
        marketOpen: false,
        selectedDate: '2026-04-10',
      }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('date=2026-04-10');
  });

  it('passes asOf as ?as_of= query param in scrub mode', async () => {
    renderHook(() =>
      useWhalePositioning({
        marketOpen: true,
        selectedDate: '2026-04-14',
        asOf: '2026-04-14T14:30:00Z',
      }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('date=2026-04-14');
    expect(calledUrl).toContain(
      'as_of=' + encodeURIComponent('2026-04-14T14:30:00Z'),
    );
  });

  it('does not poll in scrub mode even when marketOpen=true', async () => {
    renderHook(() =>
      useWhalePositioning({
        marketOpen: true,
        selectedDate: '2026-04-14',
        asOf: '2026-04-14T14:30:00Z',
        pollIntervalMs: 10_000,
      }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    // Still only the initial one-shot fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not poll for a past selectedDate even when marketOpen=true', async () => {
    // Use a date that cannot be today.
    renderHook(() =>
      useWhalePositioning({
        marketOpen: true,
        selectedDate: '2020-01-01',
        pollIntervalMs: 10_000,
      }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('exposes a refresh() that re-triggers a fetch', async () => {
    const { result } = renderHook(() =>
      useWhalePositioning({ marketOpen: false }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
