/**
 * useSilentBoomFeed — paginated polling hook backing the SilentBoom
 * dashboard panel. Polls every 30s only when the date is today AND
 * marketOpen AND page === 0. Cancels in-flight fetches on unmount.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useSilentBoomFeed } from '../hooks/useSilentBoomFeed';
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
    expect(result.current.alerts).toHaveLength(1);
    expect(result.current.alerts[0]?.underlyingSymbol).toBe('SNDK');
    expect(result.current.error).toBeNull();
  });

  it('exposes the error message on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500));
    const { result } = renderHook(() =>
      useSilentBoomFeed({ date: '2026-05-07', marketOpen: false }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain('500');
    expect(result.current.alerts).toEqual([]);
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
});
