/**
 * useTickerCandles — fetches /api/ticker-candles for a ticker on a
 * given date. Lazy (gated by `enabled`), polls only when today +
 * marketOpen + enabled.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useTickerCandles } from '../hooks/useTickerCandles';
import { POLL_INTERVALS } from '../constants';
import type { TickerCandlesResponse } from '../components/LotteryFinder/types';

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

function emptyCandles(
  overrides: Partial<TickerCandlesResponse> = {},
): TickerCandlesResponse {
  return {
    ticker: 'SPY',
    date: '2026-05-07',
    previousClose: 500,
    count: 0,
    candles: [],
    marketOpen: false,
    asOf: '2026-05-07T20:00:00Z',
    ...overrides,
  };
}

const todayCt = (): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

describe('useTickerCandles', () => {
  it('does not fetch when enabled=false', async () => {
    const { result } = renderHook(() =>
      useTickerCandles({
        ticker: 'SPY',
        date: '2026-05-07',
        enabled: false,
        marketOpen: false,
      }),
    );
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('builds the URL with ticker + date', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(emptyCandles()));
    renderHook(() =>
      useTickerCandles({
        ticker: 'SPY',
        date: '2026-05-07',
        enabled: true,
        marketOpen: false,
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/api/ticker-candles?');
    expect(url).toContain('ticker=SPY');
    expect(url).toContain('date=2026-05-07');
  });

  it('populates candles + previousClose on success', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        emptyCandles({
          previousClose: 499.5,
          count: 1,
          candles: [
            {
              ts: '2026-05-07T13:30:00Z',
              open: 500,
              high: 501,
              low: 499,
              close: 500.5,
              volume: 100000,
            },
          ],
        }),
      ),
    );
    const { result } = renderHook(() =>
      useTickerCandles({
        ticker: 'SPY',
        date: '2026-05-07',
        enabled: true,
        marketOpen: false,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.candles).toHaveLength(1);
    expect(result.current.data?.candles[0]?.close).toBe(500.5);
    expect(result.current.data?.previousClose).toBe(499.5);
    expect(result.current.error).toBeNull();
    expect(result.current.fetchedAt).not.toBeNull();
  });

  it('passes through previousClose when missing from response', async () => {
    // Phase 2M: the hook is now a thin pass-through over
    // useFetchedData; the previousClose coalesce moved to the call
    // site (e.g. `tickerCandles.data?.previousClose ?? null`).
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ticker: 'SPY',
        date: '2026-05-07',
        count: 0,
        candles: [],
        marketOpen: false,
        asOf: '2026-05-07T20:00:00Z',
      }),
    );
    const { result } = renderHook(() =>
      useTickerCandles({
        ticker: 'SPY',
        date: '2026-05-07',
        enabled: true,
        marketOpen: false,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.previousClose).toBeUndefined();
  });

  it('exposes error on non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500));
    const { result } = renderHook(() =>
      useTickerCandles({
        ticker: 'SPY',
        date: '2026-05-07',
        enabled: true,
        marketOpen: false,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain('500');
    expect(result.current.data).toBeNull();
  });

  it('captures error message on fetch reject', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network down'));
    const { result } = renderHook(() =>
      useTickerCandles({
        ticker: 'SPY',
        date: '2026-05-07',
        enabled: true,
        marketOpen: false,
      }),
    );
    await waitFor(() => expect(result.current.error).toBe('Network down'));
  });

  it('polls today + marketOpen + enabled', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(emptyCandles()));
    renderHook(() =>
      useTickerCandles({
        ticker: 'SPY',
        date: todayCt(),
        enabled: true,
        marketOpen: true,
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
  });

  it('does not poll on historical date', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(emptyCandles()));
    renderHook(() =>
      useTickerCandles({
        ticker: 'SPY',
        date: '2024-01-01',
        enabled: true,
        marketOpen: true,
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

  it('does not poll when marketOpen=false', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(emptyCandles()));
    renderHook(() =>
      useTickerCandles({
        ticker: 'SPY',
        date: todayCt(),
        enabled: true,
        marketOpen: false,
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

  it('refresh() triggers a fresh fetch', async () => {
    fetchMock.mockResolvedValue(jsonResponse(emptyCandles()));
    const { result } = renderHook(() =>
      useTickerCandles({
        ticker: 'SPY',
        date: '2024-01-01',
        enabled: true,
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

  it('nulls data when the response date != the requested date (cross-day gate)', async () => {
    // Request 2026-05-07 but the server echoes a prior day (2026-05-06):
    // the cross-day staleness gate must null the data so a stale prior-day
    // payload never renders. Matches the feed hooks' requestKey/responseKey.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        emptyCandles({
          date: '2026-05-06',
          previousClose: 499.5,
          count: 1,
          candles: [
            {
              ts: '2026-05-06T13:30:00Z',
              open: 500,
              high: 501,
              low: 499,
              close: 500.5,
              volume: 100000,
            },
          ],
        }),
      ),
    );
    const { result } = renderHook(() =>
      useTickerCandles({
        ticker: 'SPY',
        date: '2026-05-07',
        enabled: true,
        marketOpen: false,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
  });

  it('aborts in-flight fetch on unmount', async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    const pending = new Promise<unknown>((res) => {
      resolveFetch = res;
    });
    fetchMock.mockReturnValueOnce(pending);

    const { result, unmount } = renderHook(() =>
      useTickerCandles({
        ticker: 'SPY',
        date: '2026-05-07',
        enabled: true,
        marketOpen: false,
      }),
    );
    unmount();
    resolveFetch(jsonResponse(emptyCandles({ count: 1 })));
    await act(async () => {});
    expect(result.current.data).toBeNull();
  });
});
