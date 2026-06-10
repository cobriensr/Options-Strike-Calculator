/**
 * useLotteryFinderTickerCounts — chip-strip data hook for the Lottery
 * Finder dashboard. Builds /api/lottery-finder-ticker-counts with the
 * active filters, polls every 30s during market hours (skipped when
 * historical), aborts in-flight requests on filter change + unmount.
 *
 * Phase 2M-2: the hook is now a thin wrapper around `useFetchedData<T>`;
 * its return shape is the canonical `{ data, loading, error, refresh,
 * fetchedAt }`. `tickers` lives at `result.current.data?.tickers`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useLotteryFinderTickerCounts } from '../hooks/useLotteryFinderTickerCounts';

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

describe('useLotteryFinderTickerCounts', () => {
  it('builds the URL with only the date when no optional filters are set', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(EMPTY));
    renderHook(() =>
      useLotteryFinderTickerCounts({
        date: '2026-05-14',
        marketOpen: false,
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toMatch(/^\/api\/lottery-finder-ticker-counts\?/);
    expect(url).toContain('date=2026-05-14');
    expect(url).not.toContain('reload=');
    expect(url).not.toContain('cheapCallPm=');
    expect(url).not.toContain('mode=');
    expect(url).not.toContain('optionType=');
    expect(url).not.toContain('tod=');
    expect(url).not.toContain('minScore=');
    expect(url).not.toContain('showAll=');
  });

  it('appends every optional filter to the URL when supplied', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(EMPTY));
    renderHook(() =>
      useLotteryFinderTickerCounts({
        date: '2026-05-14',
        marketOpen: false,
        reload: true,
        cheapCallPm: false,
        mode: 'A_intraday_0DTE',
        optionType: 'C',
        tod: 'PM',
        minScore: 12,
        showAll: true,
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('reload=true');
    expect(url).toContain('cheapCallPm=false');
    expect(url).toContain('mode=A_intraday_0DTE');
    expect(url).toContain('optionType=C');
    expect(url).toContain('tod=PM');
    expect(url).toContain('minScore=12');
    expect(url).toContain('showAll=true');
  });

  it('omits maxFireCount from the URL when unset (default OFF — no cap)', async () => {
    // Mirrors the minFireCount floor, inverted. The free-text cap is
    // default-OFF; an unset cap (0/undefined) must NOT serialize, so
    // the server's `.optional()` default holds and the count CTE stays
    // unfiltered.
    fetchMock.mockResolvedValueOnce(jsonResponse(EMPTY));
    renderHook(() =>
      useLotteryFinderTickerCounts({
        date: '2026-05-14',
        marketOpen: false,
        maxFireCount: 0,
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).not.toContain('maxFireCount=');
  });

  it('appends maxFireCount to the URL when set (>= 1, server-side cap)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(EMPTY));
    renderHook(() =>
      useLotteryFinderTickerCounts({
        date: '2026-05-14',
        marketOpen: false,
        maxFireCount: 12,
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('maxFireCount=12');
  });

  it('omits showAll from the URL when false (default)', async () => {
    // The chip-strip endpoint applies Q1/Q2 suppression by default,
    // matching the feed. The URL builder must NOT send `showAll=false`
    // (the Zod transform treats anything other than literal 'true' as
    // false, so an explicit 'false' would still suppress — but staying
    // off the URL keeps the contract clean and the request URL shorter).
    fetchMock.mockResolvedValueOnce(jsonResponse(EMPTY));
    renderHook(() =>
      useLotteryFinderTickerCounts({
        date: '2026-05-14',
        marketOpen: false,
        showAll: false,
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).not.toContain('showAll=');
  });

  it('exposes tickers + clears loading on success', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        date: '2026-05-14',
        tickers: [
          {
            ticker: 'SPY',
            count: 4,
            peakBestPct: 18.2,
            latestTriggerTimeCt: '10:42',
          },
          {
            ticker: 'QQQ',
            count: 2,
            peakBestPct: null,
            latestTriggerTimeCt: '11:15',
          },
        ],
      }),
    );
    const { result } = renderHook(() =>
      useLotteryFinderTickerCounts({
        date: '2026-05-14',
        marketOpen: false,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.tickers).toHaveLength(2);
    expect(result.current.data?.tickers[0]?.ticker).toBe('SPY');
    expect(result.current.error).toBeNull();
    expect(result.current.fetchedAt).toBeTypeOf('number');
  });

  it('exposes the error message on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'down' }, 500));
    const { result } = renderHook(() =>
      useLotteryFinderTickerCounts({
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
      useLotteryFinderTickerCounts({
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
      useLotteryFinderTickerCounts({
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
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not poll when historical=true even with marketOpen', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(EMPTY));
    renderHook(() =>
      useLotteryFinderTickerCounts({
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
      useLotteryFinderTickerCounts({
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
      useLotteryFinderTickerCounts({
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

  it('wires the cross-day gate: a prior-day response is nulled', async () => {
    // Proves the hook passes `requestKey: date` + `responseKey` so the
    // primitive gate fires: a prior-day response surfaces as "not loaded"
    // (data === null) so stale chip counts never render under today's date.
    // (The matching-date passthrough is covered by the success test.)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        date: '2026-05-13', // prior day, != requested 2026-05-14
        tickers: [
          {
            ticker: 'SPY',
            count: 4,
            peakBestPct: 18.2,
            latestTriggerTimeCt: '10:42',
          },
        ],
      }),
    );
    const { result } = renderHook(() =>
      useLotteryFinderTickerCounts({
        date: '2026-05-14',
        marketOpen: false,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
  });
});
