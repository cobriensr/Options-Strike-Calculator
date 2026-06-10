/**
 * useSilentBoomTickerCounts — chip-strip data hook for the Silent Boom
 * dashboard. Mirrors useSilentBoomFeed's filter surface minus ticker /
 * pagination / sort. Polls every 30s during market hours, skipped when
 * historical or marketOpen=false.
 *
 * Phase 2M-2: the hook is now a thin wrapper around `useFetchedData<T>`;
 * its return shape is the canonical `{ data, loading, error, refresh,
 * fetchedAt }`. `tickers` lives at `result.current.data?.tickers`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useSilentBoomTickerCounts } from '../hooks/useSilentBoomTickerCounts';

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

const EMPTY = { date: '2026-05-14', tickers: [] };

describe('useSilentBoomTickerCounts', () => {
  it('builds the URL with date + default min thresholds when no optional filters are set', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(EMPTY));
    renderHook(() =>
      useSilentBoomTickerCounts({
        date: '2026-05-14',
        marketOpen: false,
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toMatch(/^\/api\/silent-boom-ticker-counts\?/);
    expect(url).toContain('date=2026-05-14');
    expect(url).toContain('minVolOi=0.5');
    expect(url).toContain('minSpikeRatio=0');
    expect(url).not.toContain('optionType=');
    expect(url).not.toContain('minScore=');
    expect(url).not.toContain('tod=');
    expect(url).not.toContain('dte=');
    expect(url).not.toContain('burst=');
    expect(url).not.toContain('askPctBand=');
  });

  it('appends every optional filter when supplied', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(EMPTY));
    renderHook(() =>
      useSilentBoomTickerCounts({
        date: '2026-05-14',
        marketOpen: false,
        optionType: 'P',
        minVolOi: 1,
        minSpikeRatio: 10,
        minScore: 21,
        tod: 'AM_open',
        dte: '1-3',
        burst: 'grey',
        askPctBand: '100',
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('optionType=P');
    expect(url).toContain('minVolOi=1');
    expect(url).toContain('minSpikeRatio=10');
    expect(url).toContain('minScore=21');
    expect(url).toContain('tod=AM_open');
    expect(url).toContain('dte=1-3');
    expect(url).toContain('burst=grey');
    expect(url).toContain('askPctBand=100');
  });

  it('exposes tickers + clears loading on success', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        date: '2026-05-14',
        tickers: [
          {
            ticker: 'SNDK',
            count: 3,
            peakBestPct: 27.5,
            latestBucketCt: '13:20',
          },
        ],
      }),
    );
    const { result } = renderHook(() =>
      useSilentBoomTickerCounts({
        date: '2026-05-14',
        marketOpen: false,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.tickers).toHaveLength(1);
    expect(result.current.data?.tickers[0]?.ticker).toBe('SNDK');
    expect(result.current.error).toBeNull();
    expect(result.current.fetchedAt).toBeTypeOf('number');
  });

  it('exposes an HTTP error message on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500));
    const { result } = renderHook(() =>
      useSilentBoomTickerCounts({
        date: '2026-05-14',
        marketOpen: false,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain('500');
    expect(result.current.data).toBeNull();
  });

  it('surfaces a rejected fetch as a string error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const { result } = renderHook(() =>
      useSilentBoomTickerCounts({
        date: '2026-05-14',
        marketOpen: false,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('network down');
  });

  it('polls every 30s when marketOpen + non-historical', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(EMPTY));
    renderHook(() =>
      useSilentBoomTickerCounts({
        date: '2026-05-14',
        marketOpen: true,
        historical: false,
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not poll when historical=true even with marketOpen', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(EMPTY));
    renderHook(() =>
      useSilentBoomTickerCounts({
        date: '2024-01-01',
        marketOpen: true,
        historical: true,
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
    fetchMock.mockResolvedValue(jsonResponse(EMPTY));
    renderHook(() =>
      useSilentBoomTickerCounts({
        date: '2026-05-14',
        marketOpen: false,
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

  it('exposes refresh that triggers a fresh fetch', async () => {
    fetchMock.mockResolvedValue(jsonResponse(EMPTY));
    const { result } = renderHook(() =>
      useSilentBoomTickerCounts({
        date: '2026-05-14',
        marketOpen: false,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('wires the cross-day gate: a response echoing a different day is nulled', async () => {
    // Proves the hook passes `requestKey: date` + `responseKey` so the
    // primitive gate fires: a prior-day response surfaces as "not loaded"
    // (data === null) so stale ticker counts never render under today's
    // date. (The matching-date passthrough is covered by the success test.)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        date: '2026-05-13', // prior day, != requested 2026-05-14
        tickers: [
          {
            ticker: 'SNDK',
            count: 9,
            peakBestPct: 50,
            latestBucketCt: '15:55',
          },
        ],
      }),
    );
    const { result } = renderHook(() =>
      useSilentBoomTickerCounts({
        date: '2026-05-14',
        marketOpen: false,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
  });
});
