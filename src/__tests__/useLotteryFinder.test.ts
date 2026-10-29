/**
 * useLotteryFinder — fetches /api/lottery-finder with a paginated +
 * filterable query. Polls every POLL_INTERVALS.OTM_FLOW when marketOpen,
 * no minute scrubber selected, and on page 0.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useLotteryFinder } from '../hooks/useLotteryFinder';
import { POLL_INTERVALS } from '../constants';
import { getCTDateStr } from '../utils/timezone';
import { captureUnlessAuth } from '../lib/sentry-helpers';
import { INVALID_SHAPE_ERROR } from '../lib/response-guard';
import type { LotteryFinderResponse } from '../components/LotteryFinder/types';

vi.mock('../lib/sentry-helpers', () => ({
  captureUnlessAuth: vi.fn(),
}));
const mockCaptureUnlessAuth = vi.mocked(captureUnlessAuth);

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  mockCaptureUnlessAuth.mockReset();
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

  it('omits maxFireCount when null (default OFF — no cap)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(emptyFinder()));
    renderHook(() =>
      useLotteryFinder({
        date: '2026-05-07',
        marketOpen: false,
        maxFireCount: null,
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).not.toContain('maxFireCount=');
  });

  it('appends maxFireCount when >= 1 (server-side burst cap)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(emptyFinder()));
    renderHook(() =>
      useLotteryFinder({
        date: '2026-05-07',
        marketOpen: false,
        maxFireCount: 12,
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('maxFireCount=12');
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
    // Pin wall-clock to a fixed instant so the hook's `historical` gate
    // (`date !== getCTDateStr(new Date())`) sees `date` AS today. Fake timers
    // mock Date, so without this the hook would read 1970 and gate historical.
    vi.setSystemTime(new Date('2026-06-09T18:00:00Z'));
    const today = getCTDateStr(new Date());
    fetchMock.mockResolvedValue(jsonResponse(emptyFinder({ date: today })));
    renderHook(() =>
      // TODAY in CT — otherwise FIX 2 gates this to historical (no poll).
      useLotteryFinder({ date: today, marketOpen: true }),
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

  it('does not poll a HISTORICAL (past) date even on page 0 with no minute', async () => {
    // FIX 2: a past trading day is an immutable snapshot. `historical` must
    // include the `date !== todayCt()` term, so browsing a past date (page 0,
    // no minute) single-fetches instead of polling an unchanging snapshot.
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(
      jsonResponse(emptyFinder({ date: '2020-01-02' })),
    );
    renderHook(() =>
      useLotteryFinder({ date: '2020-01-02', marketOpen: true }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVALS.OTM_FLOW * 3);
    });
    // Still a single fetch — no polling of an immutable past snapshot.
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
    // Each page echoes its requested `offset` (page * 50) — the cache's
    // ownership guard (FIX 3) attributes a payload to a url only when its
    // `offset` matches the requested offset.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(emptyFinder({ total: 100, count: 1, offset: 0 })),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse(emptyFinder({ total: 100, count: 2, offset: 50 })),
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
    resolveRevalidate(
      jsonResponse(emptyFinder({ total: 100, count: 1, offset: 0 })),
    );
  });

  it('FIX 3: back-nav after a page-0 poll returns the CACHED page, not the just-polled page-0 data', async () => {
    // Per-URL freshness. With a single GLOBAL lastSavedFetchedAt the memo,
    // when the URL flips back to a cached page in the SAME commit that a
    // page-0 poll resolved, sees `fetched.fetchedAt` (the fresh page-0 tick) >
    // global lastSaved and returns page-0's payload under the page-2 URL for
    // one frame — the exact stale flash the cache exists to prevent. Freshness
    // must be tracked PER URL.
    //
    // count is the page marker: page 0 → 10/11; page 2 → 22. Each page echoes
    // its requested offset (page 0 → 0, page 2 → 100) so the cache's ownership
    // guard attributes each payload to the right url.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(emptyFinder({ total: 200, count: 10, offset: 0 })),
    ); // page 0 initial
    fetchMock.mockResolvedValueOnce(
      jsonResponse(emptyFinder({ total: 200, count: 22, offset: 100 })),
    ); // page 2 initial

    const { result, rerender } = renderHook(
      ({ page }: { page: number }) =>
        useLotteryFinder({ date: '2026-05-07', marketOpen: false, page }),
      { initialProps: { page: 0 } },
    );

    // Page 0 loads → cache[url0] = {count:10}, global lastSaved advances to t0.
    await waitFor(() => expect(result.current.data?.count).toBe(10));

    // Forward to page 2 → cache[url2] = {count:22}, global lastSaved → t2.
    rerender({ page: 2 });
    await waitFor(() => expect(result.current.data?.count).toBe(22));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Back on page 0. Its revalidate resolves with a FRESH payload (count 11)
    // — its `fetchedAt` becomes the newest. CRUCIALLY, in the SAME act flush
    // we also flip the URL back to page 2 right after the resolve, before the
    // save effect for that fresh page-0 payload advances the global lastSaved.
    // At the page-2 render the memo sees `fetched.fetchedAt` (page-0 t3) >
    // global lastSaved (still t2) and a GLOBAL check returns the page-0 (11)
    // payload under url2 — the one-frame stale flash. Per-URL freshness must
    // return the page-2 cache (22).
    let resolvePage0: (v: unknown) => void = () => {};
    fetchMock.mockReturnValueOnce(
      new Promise((res) => {
        resolvePage0 = res;
      }),
    );
    // page-2 revalidate (held open) for the final flip back.
    fetchMock.mockReturnValueOnce(
      new Promise(() => {
        // never resolves during the assertion window
      }),
    );

    rerender({ page: 0 });
    // Cache hit renders page 0's stored {count:10} immediately.
    await waitFor(() => expect(result.current.data?.count).toBe(10));
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await act(async () => {
      // Resolve the fresh page-0 payload (offset 0), then flip to page 2 in
      // the SAME flush so the save effect hasn't advanced freshness yet.
      resolvePage0(
        jsonResponse(emptyFinder({ total: 200, count: 11, offset: 0 })),
      );
      rerender({ page: 2 });
    });

    // The cached page-2 payload (22), NOT the fresher page-0 payload, must
    // render. A global lastSavedFetchedAt yields 11 here; per-URL + the
    // offset-ownership guard keep the page-2 cache.
    expect(result.current.data?.count).toBe(22);
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

  it('wires the cross-day gate BEFORE the page cache: a prior-day response is nulled', async () => {
    // Proves the hook passes `requestKey: date` + `responseKey` so the
    // primitive gate fires at the data layer — a prior-day response is
    // nulled BEFORE the page-cache save effect reads `fetched.data`, so the
    // cache never stores cross-day data and every derived value (fires,
    // total, hasMore, offset) stays coherent. (The matching-date
    // passthrough is covered by the success/cache tests above.)
    fetchMock.mockResolvedValueOnce(
      jsonResponse(emptyFinder({ date: '2026-05-06', total: 100, count: 1 })),
    );
    const { result } = renderHook(() =>
      useLotteryFinder({ date: '2026-05-07', marketOpen: false }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
  });
});

// ============================================================
// Spread-leg fields (spec 2026-10-28-classifier-replacement-design.md,
// "Badge"). The response schema guards the fields the row badge and the
// reignites markers render from; everything else passes through.
// ============================================================

describe('useLotteryFinder: spread-leg response schema', () => {
  type Fire = LotteryFinderResponse['fires'][number];
  const fire = (fields: Record<string, unknown>): Fire =>
    ({ id: 1, ...fields }) as unknown as Fire;

  const LEGS = [
    {
      optionType: 'C',
      strike: 726,
      expiry: '2026-05-07',
      size: 40,
      price: 1.15,
      tradeCode: 'mlet',
    },
    {
      optionType: 'C',
      strike: 727,
      expiry: '2026-05-07',
      size: 40,
      price: 0.7,
      tradeCode: null,
    },
  ];
  const SPREAD_LEG = { fires: 2, totalFires: 5, shape: 'vertical', legs: LEGS };

  async function load(body: unknown) {
    fetchMock.mockResolvedValueOnce(jsonResponse(body));
    const hook = renderHook(() =>
      useLotteryFinder({ date: '2026-05-07', marketOpen: false }),
    );
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    return hook;
  }

  it('accepts and passes through the spread-leg fields', async () => {
    const body = emptyFinder({
      fires: [
        fire({
          anchorLegKind: 'single',
          spreadLeg: SPREAD_LEG,
          historicalFires: [
            {
              triggerTimeCt: '2026-05-07T14:00:00Z',
              entryPrice: 0.5,
              spotAtTrigger: 100,
              anchorLegKind: 'multi_leg',
            },
          ],
        }),
      ],
      reignitedFires: [
        fire({ id: 2, anchorLegKind: 'stock_tied', spreadLeg: null }),
      ],
    });
    const { result } = await load(body);
    expect(result.current.error).toBeNull();
    expect(result.current.data?.fires[0]).toMatchObject({
      anchorLegKind: 'single',
      spreadLeg: SPREAD_LEG,
      historicalFires: [{ anchorLegKind: 'multi_leg' }],
    });
    expect(result.current.data?.reignitedFires?.[0]?.anchorLegKind).toBe(
      'stock_tied',
    );
    expect(mockCaptureUnlessAuth).not.toHaveBeenCalled();
  });

  it('accepts missing and null spread-leg fields (old rows, pre-#197 fires)', async () => {
    const body = emptyFinder({
      fires: [
        fire({}),
        fire({
          id: 2,
          anchorLegKind: null,
          spreadLeg: null,
          historicalFires: [
            { triggerTimeCt: '2026-05-07T14:00:00Z', entryPrice: 0.5 },
            {
              triggerTimeCt: '2026-05-07T14:10:00Z',
              entryPrice: 0.5,
              anchorLegKind: null,
            },
          ],
        }),
      ],
    });
    const { result } = await load(body);
    expect(result.current.error).toBeNull();
    expect(result.current.data?.fires).toHaveLength(2);
    expect(mockCaptureUnlessAuth).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown anchorLegKind', { anchorLegKind: 'spread' }],
    [
      'an unknown spread shape',
      { spreadLeg: { ...SPREAD_LEG, shape: 'iron_condor' } },
    ],
    ['legs that are not an array', { spreadLeg: { ...SPREAD_LEG, legs: {} } }],
    [
      'a leg with a string strike',
      {
        spreadLeg: {
          ...SPREAD_LEG,
          legs: [{ ...LEGS[0], strike: '726' }],
        },
      },
    ],
    ['a zero spread-leg count', { spreadLeg: { ...SPREAD_LEG, fires: 0 } }],
    ['a fractional total', { spreadLeg: { ...SPREAD_LEG, totalFires: 2.5 } }],
    [
      'an unknown leg kind on a past fire',
      {
        historicalFires: [
          {
            triggerTimeCt: '2026-05-07T14:00:00Z',
            entryPrice: 0.5,
            anchorLegKind: 'multi',
          },
        ],
      },
    ],
  ])(
    'rejects a fire with %s: handled as a failed fetch and reported once',
    async (_label, fields) => {
      const { result } = await load(emptyFinder({ fires: [fire(fields)] }));
      expect(result.current.error).toBe(INVALID_SHAPE_ERROR);
      expect(result.current.data).toBeNull();
      expect(mockCaptureUnlessAuth).toHaveBeenCalledTimes(1);
      const [err, ctx] = mockCaptureUnlessAuth.mock.calls[0]!;
      expect((err as Error).message).toBe(
        'lottery-finder response failed schema validation',
      );
      expect(ctx).toMatchObject({
        contexts: {
          lotteryFinder: {
            date: '2026-05-07',
            issues: [expect.stringMatching(/^fires\.0\./)],
            issueCount: 1,
          },
        },
      });
    },
  );

  it('rejects a malformed pinned reignited fire too', async () => {
    const { result } = await load(
      emptyFinder({ reignitedFires: [fire({ anchorLegKind: 'x' })] }),
    );
    expect(result.current.error).toBe(INVALID_SHAPE_ERROR);
    expect(result.current.data).toBeNull();
  });

  it('rejects a body whose fires is not an array', async () => {
    const { result } = await load({ ...emptyFinder(), fires: null });
    expect(result.current.error).toBe(INVALID_SHAPE_ERROR);
    expect(result.current.data).toBeNull();
  });

  it('keeps the last good payload, and reports a repeating failure once until a good response re-arms it', async () => {
    const good = emptyFinder({ total: 7, fires: [fire({ spreadLeg: null })] });
    const bad = emptyFinder({ fires: [fire({ anchorLegKind: 'x' })] });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(good))
      .mockResolvedValueOnce(jsonResponse(bad))
      .mockResolvedValueOnce(jsonResponse(bad))
      .mockResolvedValueOnce(jsonResponse(good))
      .mockResolvedValueOnce(jsonResponse(bad));
    const { result } = renderHook(() =>
      useLotteryFinder({ date: '2026-05-07', marketOpen: false }),
    );
    await waitFor(() => expect(result.current.data?.total).toBe(7));

    const refreshAndSettle = async (calls: number) => {
      await act(async () => {
        result.current.refresh();
      });
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(calls));
      await waitFor(() => expect(result.current.loading).toBe(false));
    };

    await refreshAndSettle(2);
    expect(result.current.error).toBe(INVALID_SHAPE_ERROR);
    // Nothing malformed is stored: the last good payload stays.
    expect(result.current.data?.total).toBe(7);
    await refreshAndSettle(3);
    expect(mockCaptureUnlessAuth).toHaveBeenCalledTimes(1);

    await refreshAndSettle(4);
    expect(result.current.error).toBeNull();
    await refreshAndSettle(5);
    expect(mockCaptureUnlessAuth).toHaveBeenCalledTimes(2);
  });
});
