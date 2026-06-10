/**
 * useSilentBoomFeed — paginated polling hook backing the SilentBoom
 * dashboard panel. Polls every 30s only when the date is today AND
 * marketOpen AND page === 0. Cancels in-flight fetches on unmount.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useSilentBoomFeed } from '../hooks/useSilentBoomFeed';
import { POLL_INTERVALS } from '../constants';
import { getCTDateStr } from '../utils/timezone';
import type { SilentBoomFeedResponse } from '../components/SilentBoom/types';

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

function emptyFeed(
  overrides: Partial<SilentBoomFeedResponse> = {},
): SilentBoomFeedResponse {
  return {
    date: '2026-05-07',
    filters: {
      minVolOi: 0.5,
      minSpikeRatio: 0,
      minScore: null,
      tod: null,
      dte: null,
      burst: null,
      askPctBand: null,
      sort: 'newest',
      aggressivePremium: false,
    },
    count: 0,
    total: 0,
    limit: 50,
    offset: 0,
    hasMore: false,
    alerts: [],
    ...overrides,
  };
}

describe('useSilentBoomFeed', () => {
  it('builds the URL with date, limit, offset, sort, vol/OI floor, and spike-ratio floor', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(emptyFeed()));
    renderHook(() =>
      useSilentBoomFeed({
        date: '2026-05-07',
        marketOpen: false,
        sort: 'spike_ratio',
        minVolOi: 1,
        minSpikeRatio: 10,
        page: 2,
        pageSize: 25,
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/api/silent-boom-feed?');
    expect(url).toContain('date=2026-05-07');
    expect(url).toContain('limit=25');
    expect(url).toContain('offset=50'); // page * pageSize
    expect(url).toContain('sort=spike_ratio');
    expect(url).toContain('minVolOi=1');
    expect(url).toContain('minSpikeRatio=10');
  });

  it('attaches optional ticker and optionType filters when provided', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(emptyFeed()));
    renderHook(() =>
      useSilentBoomFeed({
        date: '2026-05-07',
        marketOpen: false,
        ticker: 'SPY',
        optionType: 'P',
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('ticker=SPY');
    expect(url).toContain('optionType=P');
  });

  it('omits ticker / optionType when not supplied', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(emptyFeed()));
    renderHook(() =>
      useSilentBoomFeed({ date: '2026-05-07', marketOpen: false }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).not.toContain('ticker=');
    expect(url).not.toContain('optionType=');
  });

  it('appends minScore to the URL when supplied', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(emptyFeed()));
    renderHook(() =>
      useSilentBoomFeed({
        date: '2026-05-07',
        marketOpen: false,
        minScore: 21,
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('minScore=21');
  });

  it('omits minScore when null/undefined', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(emptyFeed()));
    renderHook(() =>
      useSilentBoomFeed({
        date: '2026-05-07',
        marketOpen: false,
        minScore: null,
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).not.toContain('minScore=');
  });

  it('appends tod when supplied', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(emptyFeed()));
    renderHook(() =>
      useSilentBoomFeed({
        date: '2026-05-07',
        marketOpen: false,
        tod: 'AM_open',
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('tod=AM_open');
  });

  it('omits tod when null', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(emptyFeed()));
    renderHook(() =>
      useSilentBoomFeed({ date: '2026-05-07', marketOpen: false, tod: null }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).not.toContain('tod=');
  });

  it('clears loading and exposes alerts on success', async () => {
    // Phase 2M-4: hook now returns `{ data, loading, error, refresh,
    // fetchedAt }` — `alerts` and the other paged fields live under
    // `data` and are read via `result.current.data?.alerts ?? []`.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        emptyFeed({
          total: 1,
          count: 1,
          alerts: [
            {
              id: 1,
              date: '2026-05-07',
              bucketCt: '2026-05-07T13:20:00Z',
              optionChainId: 'SNDK260507C01175000',
              underlyingSymbol: 'SNDK',
              optionType: 'C',
              strike: 1175,
              expiry: '2026-05-07',
              dte: 0,
              spikeVolume: 2000,
              baselineVolume: 100,
              spikeRatio: 20,
              askPct: 1,
              volOi: 0.4,
              entryPrice: 0.5,
              openInterest: 5000,
              score: 24,
              scoreTier: 'tier1',
              directionGated: false,
              mktTideDiff: 5000,
              zeroDteDiff: 300,
              spxSpotGammaOi: 12345,
              underlyingPriceAtSpike: 580,
              multiLegShare: 0.25,
              tickerCumNcpAtFire: null,
              tickerCumNppAtFire: null,
              gex: {
                oneCvroflow: null,
                netPutDex: null,
                oneDexoflow: null,
                oneGexoflow: null,
                zcvr: null,
                zeroGamma: null,
                spot: null,
                capturedAt: null,
              },
              avgHoldMinutes: 144,
              outcomes: {
                peakCeilingPct: 25,
                minutesToPeak: 18,
                realized30mPct: 12,
                realized60mPct: 8,
                realized120mPct: 4,
                realizedEodPct: 2,
                realizedTrail3010Pct: null,
                enrichedAt: '2026-05-07T16:00:00Z',
              },
              insertedAt: '2026-05-07T13:20:30Z',
            },
          ],
        }),
      ),
    );
    const { result } = renderHook(() =>
      useSilentBoomFeed({ date: '2026-05-07', marketOpen: false }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.alerts).toHaveLength(1);
    expect(result.current.data?.alerts[0]?.underlyingSymbol).toBe('SNDK');
    expect(result.current.error).toBeNull();
  });

  it('exposes the error message on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500));
    const { result } = renderHook(() =>
      useSilentBoomFeed({ date: '2026-05-07', marketOpen: false }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain('500');
    expect(result.current.data).toBeNull();
  });

  it('does not poll when historical=true (date is in the past)', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(emptyFeed()));
    renderHook(() =>
      useSilentBoomFeed({
        date: '2024-01-01',
        marketOpen: true,
        historical: true,
      }),
    );
    // Initial fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Advance well past the 30s poll interval — historical should
    // NOT trigger a second fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not poll when page > 0 even on a live date', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(emptyFeed()));
    renderHook(() =>
      useSilentBoomFeed({
        date: '2026-05-07',
        marketOpen: true,
        historical: false,
        page: 1,
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not poll when marketOpen=false', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(emptyFeed()));
    renderHook(() =>
      useSilentBoomFeed({
        date: '2026-05-07',
        marketOpen: false,
        historical: false,
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('appends dte when supplied', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(emptyFeed()));
    renderHook(() =>
      useSilentBoomFeed({
        date: '2026-05-07',
        marketOpen: false,
        dte: '1-3',
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('dte=1-3');
  });

  it('appends burst when supplied', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(emptyFeed()));
    renderHook(() =>
      useSilentBoomFeed({
        date: '2026-05-07',
        marketOpen: false,
        burst: 'grey',
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('burst=grey');
  });

  it('omits dte and burst when null', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(emptyFeed()));
    renderHook(() =>
      useSilentBoomFeed({
        date: '2026-05-07',
        marketOpen: false,
        dte: null,
        burst: null,
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).not.toContain('dte=');
    expect(url).not.toContain('burst=');
  });

  it('appends askPctBand when supplied', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(emptyFeed()));
    renderHook(() =>
      useSilentBoomFeed({
        date: '2026-05-07',
        marketOpen: false,
        askPctBand: '100',
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('askPctBand=100');
  });

  it('omits askPctBand when null', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(emptyFeed()));
    renderHook(() =>
      useSilentBoomFeed({
        date: '2026-05-07',
        marketOpen: false,
        askPctBand: null,
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).not.toContain('askPctBand=');
  });

  it('omits minTakeitProb when null or 0 (matches "all" preset)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(emptyFeed()));
    renderHook(() =>
      useSilentBoomFeed({
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
    fetchMock.mockResolvedValueOnce(jsonResponse(emptyFeed()));
    renderHook(() =>
      useSilentBoomFeed({
        date: '2026-05-07',
        marketOpen: false,
        minTakeitProb: 0.7,
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('minTakeitProb=0.7');
  });

  it('wires the cross-day gate: a response echoing a different day is nulled', async () => {
    // Proves the hook passes `requestKey: date` + `responseKey` so the
    // primitive gate fires: a prior-day response surfaces as "not loaded"
    // so a never-vanish union never ingests yesterday's alerts under
    // today's date. (The matching-date passthrough is already exercised by
    // the success/loading tests above, whose fixtures echo the requested
    // date.)
    fetchMock.mockResolvedValueOnce(
      jsonResponse(emptyFeed({ date: '2026-05-06', total: 1, count: 1 })),
    );
    const { result } = renderHook(() =>
      useSilentBoomFeed({ date: '2026-05-07', marketOpen: false }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
  });

  // ── Shared-machinery parity with useLotteryFinder.test.ts ───────────
  //
  // Both feed hooks are thin wrappers over the same `useFetchedData`
  // primitive (polling, AbortController, refresh). The sibling Lottery
  // suite exercises these; ported here so the SB feed has the same
  // guarantees. NOTE: the Lottery page-cache tests are deliberately NOT
  // ported — that `cacheRef` lives only in useLotteryFinder, not the SB
  // hook, so there is no SB behavior to characterize.

  it('polls every OTM_FLOW when marketOpen + today + page 0', async () => {
    vi.useFakeTimers();
    // Pin wall-clock so the hook's `historical` gate (page !== 0 only for
    // SB — date isn't part of the SB gate, but pin anyway for stability).
    vi.setSystemTime(new Date('2026-06-09T18:00:00Z'));
    const today = getCTDateStr(new Date());
    fetchMock.mockResolvedValue(jsonResponse(emptyFeed({ date: today })));
    renderHook(() =>
      useSilentBoomFeed({
        date: today,
        marketOpen: true,
        historical: false,
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVALS.OTM_FLOW);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVALS.OTM_FLOW);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('refresh() triggers a fresh fetch', async () => {
    fetchMock.mockResolvedValue(jsonResponse(emptyFeed()));
    const { result } = renderHook(() =>
      useSilentBoomFeed({ date: '2026-05-07', marketOpen: false }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('aborts in-flight fetch on unmount (data stays null)', async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    const pending = new Promise<unknown>((res) => {
      resolveFetch = res;
    });
    fetchMock.mockReturnValueOnce(pending);

    const { result, unmount } = renderHook(() =>
      useSilentBoomFeed({ date: '2026-05-07', marketOpen: false }),
    );
    unmount();
    // Resolve AFTER unmount — the AbortController in useFetchedData must
    // have fired, so the resolved payload never reaches state.
    resolveFetch(jsonResponse(emptyFeed({ total: 99 })));
    await act(async () => {});
    expect(result.current.data).toBeNull();
  });

  it('cancels a prior in-flight fetch when filters change (no clobber)', async () => {
    // First request is held open; the rerender (ticker change) supersedes
    // it. When the now-stale first request resolves it must NOT overwrite
    // the second request's state.
    let resolveFirst: (v: unknown) => void = () => {};
    const pendingFirst = new Promise<unknown>((res) => {
      resolveFirst = res;
    });
    fetchMock.mockReturnValueOnce(pendingFirst);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(emptyFeed({ total: 5, count: 0 })),
    );

    const { result, rerender } = renderHook(
      ({ ticker }: { ticker: string | null }) =>
        useSilentBoomFeed({ date: '2026-05-07', marketOpen: false, ticker }),
      { initialProps: { ticker: null as string | null } },
    );

    rerender({ ticker: 'SPY' });
    // Resolve the now-stale first request — should not clobber state.
    resolveFirst(jsonResponse(emptyFeed({ total: 9999, count: 0 })));

    await waitFor(() => expect(result.current.data?.total).toBe(5));
    expect(result.current.data?.total).not.toBe(9999);
  });
});
