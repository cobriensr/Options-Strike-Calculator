/**
 * useLotteryFinder — fetches /api/lottery-finder with a paginated +
 * filterable query. Polls every POLL_INTERVALS.OTM_FLOW when marketOpen,
 * no minute scrubber selected, and on page 0.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useLotteryFinder } from '../hooks/useLotteryFinder';
import { POLL_INTERVALS } from '../constants';
import type { LotteryFinderResponse } from '../components/LotteryFinder/types';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function emptyFinder(
  overrides: Partial<LotteryFinderResponse> = {},
): LotteryFinderResponse {
  return {
    date: '2026-05-07',
    asOf: null,
    minute: null,
    filters: {},
    count: 0,
    total: 0,
    limit: 50,
    offset: 0,
    hasMore: false,
    fires: [],
    ...overrides,
  };
}

describe('useLotteryFinder', () => {
  it('builds default URL with date, limit=50, offset=0 and omits all optional params', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(emptyFinder()));
    renderHook(() =>
      useLotteryFinder({ date: '2026-05-07', marketOpen: false }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/api/lottery-finder?');
    expect(url).toContain('date=2026-05-07');
    expect(url).toContain('limit=50');
    expect(url).toContain('offset=0');
    // sort=chronological is default — should NOT be on the wire.
    expect(url).not.toContain('sort=');
    expect(url).not.toContain('minute=');
    expect(url).not.toContain('ticker=');
    expect(url).not.toContain('reload=');
    expect(url).not.toContain('cheapCallPm=');
    expect(url).not.toContain('mode=');
    expect(url).not.toContain('optionType=');
    expect(url).not.toContain('tod=');
    expect(url).not.toContain('minScore=');
    // minPremium default (null) is also omitted from the wire so the
    // server's `.optional()` default holds.
    expect(url).not.toContain('minPremium=');
  });

  it('omits minPremium when 0 (matches null floor)', async () => {
    // The chip resets to 0 (no floor); the hook must NOT serialize a
    // 0 floor — it would pin the server to `minPremium=0` and trip
    // the `> 0` server guard. Mirrors useSilentBoomFeed's behavior.
    fetchMock.mockResolvedValueOnce(jsonResponse(emptyFinder()));
    renderHook(() =>
      useLotteryFinder({
        date: '2026-05-07',
        marketOpen: false,
        minPremium: 0,
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).not.toContain('minPremium=');
  });

  it('appends minPremium when > 0 (server-side $-floor)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(emptyFinder()));
    renderHook(() =>
      useLotteryFinder({
        date: '2026-05-07',
        marketOpen: false,
        minPremium: 100_000,
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('minPremium=100000');
  });

  it('omits minFireCount when null or <=1 (matches "all" floor)', async () => {
    // The Burst chip resets to 'all' (numeric 1) → no server-side
    // filter. Like minPremium, the hook must NOT serialize the
    // no-op floor.
    fetchMock.mockResolvedValueOnce(jsonResponse(emptyFinder()));
    renderHook(() =>
      useLotteryFinder({
        date: '2026-05-07',
        marketOpen: false,
        minFireCount: 1,
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).not.toContain('minFireCount=');
  });

  it('appends minFireCount when > 1 (server-side burst filter)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(emptyFinder()));
    renderHook(() =>
      useLotteryFinder({
        date: '2026-05-07',
        marketOpen: false,
        minFireCount: 16,
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('minFireCount=16');
  });

  it('omits minTakeitProb when null or 0 (matches "all" preset)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(emptyFinder()));
    renderHook(() =>
      useLotteryFinder({
        date: '2026-05-07',
        marketOpen: false,
        minTakeitProb: 0,
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).not.toContain('minTakeitProb=');
  });

  it('appends minTakeitProb when > 0 (server-side TAKE-IT filter)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(emptyFinder()));
    renderHook(() =>
      useLotteryFinder({
        date: '2026-05-07',
        marketOpen: false,
        minTakeitProb: 0.7,
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('minTakeitProb=0.7');
  });

  it('attaches all optional filters when supplied', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(emptyFinder()));
    renderHook(() =>
      useLotteryFinder({
        date: '2026-05-07',
        marketOpen: false,
        minute: '2026-05-07T13:30:00Z',
        ticker: 'SPY',
        reload: true,
        cheapCallPm: false,
        mode: 'A_intraday_0DTE',
        optionType: 'C',
        tod: 'AM_open',
        sort: 'score',
        minScore: 18,
        page: 2,
        pageSize: 25,
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('limit=25');
    expect(url).toContain('offset=50'); // page * pageSize
    expect(url).toContain('minute=2026-05-07T13%3A30%3A00Z');
    expect(url).toContain('ticker=SPY');
    expect(url).toContain('reload=true');
    expect(url).toContain('cheapCallPm=false');
    expect(url).toContain('mode=A_intraday_0DTE');
    expect(url).toContain('optionType=C');
    expect(url).toContain('tod=AM_open');
    expect(url).toContain('sort=score');
    expect(url).toContain('minScore=18');
  });

  it('populates fires + pagination metadata on success', async () => {
    // Phase 2M-5: hook now returns `{ data, loading, error, refresh,
    // fetchedAt }` — `fires`, `reignitedFires`, and the paged scalars
    // live under `data` and are read via `result.current.data?.fires`.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        emptyFinder({
          total: 100,
          limit: 50,
          offset: 0,
          hasMore: true,
          count: 1,
          fires: [
            // Use a structurally minimal Fire — the hook copies through verbatim.
            { id: 1 } as unknown as LotteryFinderResponse['fires'][number],
          ],
        }),
      ),
    );
    const { result } = renderHook(() =>
      useLotteryFinder({ date: '2026-05-07', marketOpen: false }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.fires).toHaveLength(1);
    expect(result.current.data?.total).toBe(100);
    expect(result.current.data?.limit).toBe(50);
    expect(result.current.data?.offset).toBe(0);
    expect(result.current.data?.hasMore).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.fetchedAt).not.toBeNull();
  });

  it('surfaces reignitedFires from the response, with [] fallback when absent', async () => {
    // Reignited rows ride alongside `fires` independent of pagination —
    // the hook must pass them through verbatim, and default to [] for
    // back-compat with server builds that haven't shipped the field.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        emptyFinder({
          reignitedFires: [
            { id: 999 } as unknown as LotteryFinderResponse['fires'][number],
          ],
        }),
      ),
    );
    const { result } = renderHook(() =>
      useLotteryFinder({ date: '2026-05-07', marketOpen: false }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.reignitedFires).toHaveLength(1);
    expect(result.current.data?.reignitedFires?.[0]!.id).toBe(999);
  });

  it('passes reignitedFires through verbatim (undefined when omitted)', async () => {
    // The legacy hook coerced `undefined` → `[]`. With useFetchedData
    // the response is delivered verbatim — consumers apply the
    // `?? []` fallback. Mirrors SilentBoom's Phase 2M-4 contract.
    fetchMock.mockResolvedValueOnce(jsonResponse(emptyFinder()));
    const { result } = renderHook(() =>
      useLotteryFinder({ date: '2026-05-07', marketOpen: false }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.reignitedFires).toBeUndefined();
  });

  it('exposes error on non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500));
    const { result } = renderHook(() =>
      useLotteryFinder({ date: '2026-05-07', marketOpen: false }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain('500');
  });

  it('captures error message on fetch reject', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network down'));
    const { result } = renderHook(() =>
      useLotteryFinder({ date: '2026-05-07', marketOpen: false }),
    );
    await waitFor(() => expect(result.current.error).toBe('Network down'));
  });

  it('polls every OTM_FLOW when marketOpen and no minute, page 0', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(emptyFinder()));
    renderHook(() =>
      useLotteryFinder({ date: '2026-05-07', marketOpen: true }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVALS.OTM_FLOW);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not poll when minute is set (historical scrub)', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(emptyFinder()));
    renderHook(() =>
      useLotteryFinder({
        date: '2026-05-07',
        marketOpen: true,
        minute: '2026-05-07T13:30:00Z',
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVALS.OTM_FLOW * 3);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not poll when page > 0', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(emptyFinder()));
    renderHook(() =>
      useLotteryFinder({ date: '2026-05-07', marketOpen: true, page: 1 }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVALS.OTM_FLOW * 3);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not poll when marketOpen=false', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(emptyFinder()));
    renderHook(() =>
      useLotteryFinder({ date: '2026-05-07', marketOpen: false }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVALS.OTM_FLOW * 3);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refresh() triggers a fresh fetch', async () => {
    fetchMock.mockResolvedValue(jsonResponse(emptyFinder()));
    const { result } = renderHook(() =>
      useLotteryFinder({ date: '2026-05-07', marketOpen: false }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('aborts in-flight fetch on unmount', async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    const pending = new Promise<unknown>((res) => {
      resolveFetch = res;
    });
    fetchMock.mockReturnValueOnce(pending);

    const { result, unmount } = renderHook(() =>
      useLotteryFinder({ date: '2026-05-07', marketOpen: false }),
    );
    unmount();
    resolveFetch(jsonResponse(emptyFinder({ total: 99 })));
    await act(async () => {});
    expect(result.current.data).toBeNull();
  });

  it('serves cached page data immediately when revisiting a previously-loaded URL', async () => {
    // Page cache: forward navigation does a real fetch; returning to
    // a prior page should render the cached response instantly while
    // a background revalidate runs. Validates that the cached value
    // is surfaced in `result.current.data` BEFORE the revalidating
    // fetch resolves — proving the cache is the source for the
    // pending render.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(emptyFinder({ total: 100, count: 1 })),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse(emptyFinder({ total: 100, count: 2 })),
    );

    const { result, rerender } = renderHook(
      ({ page }: { page: number }) =>
        useLotteryFinder({ date: '2026-05-07', marketOpen: false, page }),
      { initialProps: { page: 0 } },
    );

    // Page 0 loads — cache now contains page 0's URL.
    await waitFor(() => expect(result.current.data?.count).toBe(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Navigate forward to page 1. New URL → cache miss → fetch.
    rerender({ page: 1 });
    await waitFor(() => expect(result.current.data?.count).toBe(2));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Hold the revalidating fetch for page 0 open so we can prove
    // the cache renders instantly while the network is still in flight.
    let resolveRevalidate: (v: unknown) => void = () => {};
    fetchMock.mockReturnValueOnce(
      new Promise((res) => {
        resolveRevalidate = res;
      }),
    );

    rerender({ page: 0 });
    // Cache hit: page 0's stored response surfaces immediately, even
    // though the revalidating fetch hasn't resolved yet.
    await waitFor(() => expect(result.current.data?.count).toBe(1));
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Cleanup — resolve the held fetch so other tests don't inherit it.
    resolveRevalidate(jsonResponse(emptyFinder({ total: 100, count: 1 })));
  });

  it('cancels prior in-flight fetch when filters change', async () => {
    // First request is held open; the rerender supersedes it.
    let resolveFirst: (v: unknown) => void = () => {};
    const pendingFirst = new Promise<unknown>((res) => {
      resolveFirst = res;
    });
    fetchMock.mockReturnValueOnce(pendingFirst);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(emptyFinder({ total: 5, count: 0 })),
    );

    const { result, rerender } = renderHook(
      ({ ticker }: { ticker: string | null }) =>
        useLotteryFinder({ date: '2026-05-07', marketOpen: false, ticker }),
      { initialProps: { ticker: null as string | null } },
    );

    rerender({ ticker: 'SPY' });
    // Resolve the now-stale first request — should not clobber state.
    resolveFirst(jsonResponse(emptyFinder({ total: 9999, count: 0 })));

    await waitFor(() => expect(result.current.data?.total).toBe(5));
    expect(result.current.data?.total).not.toBe(9999);
  });
});
