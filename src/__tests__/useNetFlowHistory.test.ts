/**
 * useNetFlowHistory — fetches /api/net-flow-history for a ticker on a
 * date. Lazy (gated by `enabled`), polls only when today + marketOpen
 * + enabled. Aborts in-flight requests on unmount.
 *
 * Phase 2M-3: returns the canonical `{ data, loading, error, refresh,
 * fetchedAt }` shape via useFetchedData; assertions hit `data?.series`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useNetFlowHistory } from '../hooks/useNetFlowHistory';
import { POLL_INTERVALS } from '../constants';
import type { NetFlowHistoryResponse } from '../components/LotteryFinder/types';

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

function emptyHistory(
  overrides: Partial<NetFlowHistoryResponse> = {},
): NetFlowHistoryResponse {
  return {
    ticker: 'SPY',
    date: '2026-05-07',
    from: '2026-05-07T13:30:00Z',
    to: '2026-05-07T20:00:00Z',
    count: 0,
    series: [],
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

describe('useNetFlowHistory', () => {
  it('does not fetch when enabled=false', async () => {
    const { result } = renderHook(() =>
      useNetFlowHistory({
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

  it('builds the URL with ticker + date and from/to when supplied', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(emptyHistory()));
    renderHook(() =>
      useNetFlowHistory({
        ticker: 'SPY',
        date: '2026-05-07',
        from: '08:30',
        to: '15:00',
        enabled: true,
        marketOpen: false,
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/api/net-flow-history?');
    expect(url).toContain('ticker=SPY');
    expect(url).toContain('date=2026-05-07');
    expect(url).toContain('from=08%3A30');
    expect(url).toContain('to=15%3A00');
  });

  it('omits from/to when not supplied', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(emptyHistory()));
    renderHook(() =>
      useNetFlowHistory({
        ticker: 'SPY',
        date: '2026-05-07',
        enabled: true,
        marketOpen: false,
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).not.toContain('from=');
    expect(url).not.toContain('to=');
  });

  it('populates series + clears loading on success', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        emptyHistory({
          count: 1,
          series: [
            {
              ts: '2026-05-07T13:30:00Z',
              ncp: 1000,
              ncv: 50,
              npp: -200,
              npv: 10,
              cumNcp: 1000,
              cumNcv: 50,
              cumNpp: -200,
              cumNpv: 10,
            },
          ],
        }),
      ),
    );
    const { result } = renderHook(() =>
      useNetFlowHistory({
        ticker: 'SPY',
        date: '2026-05-07',
        enabled: true,
        marketOpen: false,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.series).toHaveLength(1);
    expect(result.current.data?.series[0]?.ncp).toBe(1000);
    expect(result.current.error).toBeNull();
    expect(result.current.fetchedAt).not.toBeNull();
  });

  it('exposes error string on non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500));
    const { result } = renderHook(() =>
      useNetFlowHistory({
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

  it('captures error message when fetch rejects', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network down'));
    const { result } = renderHook(() =>
      useNetFlowHistory({
        ticker: 'SPY',
        date: '2026-05-07',
        enabled: true,
        marketOpen: false,
      }),
    );
    await waitFor(() => expect(result.current.error).toBe('Network down'));
    expect(result.current.data).toBeNull();
  });

  it('polls today + marketOpen + enabled', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(emptyHistory()));
    renderHook(() =>
      useNetFlowHistory({
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

  it('does not poll when historical (date != today)', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(emptyHistory()));
    renderHook(() =>
      useNetFlowHistory({
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
    fetchMock.mockResolvedValue(jsonResponse(emptyHistory()));
    renderHook(() =>
      useNetFlowHistory({
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
    fetchMock.mockResolvedValue(jsonResponse(emptyHistory()));
    const { result } = renderHook(() =>
      useNetFlowHistory({
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

  it('aborts in-flight fetch on unmount without setting state', async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    const pending = new Promise<unknown>((res) => {
      resolveFetch = res;
    });
    fetchMock.mockReturnValueOnce(pending);

    const { result, unmount } = renderHook(() =>
      useNetFlowHistory({
        ticker: 'SPY',
        date: '2026-05-07',
        enabled: true,
        marketOpen: false,
      }),
    );
    unmount();
    resolveFetch(jsonResponse(emptyHistory({ count: 42 })));
    await act(async () => {});
    expect(result.current.data).toBeNull();
  });
});
