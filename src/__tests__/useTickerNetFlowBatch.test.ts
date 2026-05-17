/**
 * useTickerNetFlowBatch — polls /api/ticker-net-flow-current to keep
 * per-ticker cumulative NCP/NPP fresh for the Flow Match / Inverted
 * badges. These tests pin gating + canonicalization + URL shape +
 * polling cadence.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useTickerNetFlowBatch } from '../hooks/useTickerNetFlowBatch';
import { POLL_INTERVALS } from '../constants';

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

function snapshot(
  ticker: string,
  cumNcp: number,
  cumNpp: number,
  asOfTs = '2026-05-07T19:00:00.000Z',
) {
  return { ticker, asOfTs, cumNcp, cumNpp };
}

describe('useTickerNetFlowBatch', () => {
  it('returns empty Map and skips fetch when tickers is empty', async () => {
    const { result } = renderHook(() =>
      useTickerNetFlowBatch({
        tickers: [],
        date: '2026-05-07',
        marketOpen: true,
      }),
    );
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.data.size).toBe(0);
    expect(result.current.loading).toBe(false);
  });

  it('skips fetch when marketOpen is false', async () => {
    renderHook(() =>
      useTickerNetFlowBatch({
        tickers: ['SPY'],
        date: '2026-05-07',
        marketOpen: false,
      }),
    );
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('builds the URL with deduped + uppercased + sorted tickers', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        date: '2026-05-07',
        requestedTickers: ['AAPL', 'SPY', 'TSLA'],
        count: 0,
        snapshots: [],
      }),
    );
    renderHook(() =>
      useTickerNetFlowBatch({
        // intentionally messy: lowercase, dupes, whitespace, unsorted
        tickers: [' tsla ', 'aapl', 'SPY', 'aapl'],
        date: '2026-05-07',
        marketOpen: true,
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toBe(
      '/api/ticker-net-flow-current?tickers=AAPL%2CSPY%2CTSLA&date=2026-05-07',
    );
  });

  it('keys snapshots by ticker in the returned Map', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        date: '2026-05-07',
        requestedTickers: ['SPY', 'TSLA'],
        count: 2,
        snapshots: [
          snapshot('SPY', 1500, -500),
          snapshot('TSLA', 12345.67, -2222),
        ],
      }),
    );
    const { result } = renderHook(() =>
      useTickerNetFlowBatch({
        tickers: ['SPY', 'TSLA'],
        date: '2026-05-07',
        marketOpen: true,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data.size).toBe(2);
    expect(result.current.data.get('SPY')).toMatchObject({
      cumNcp: 1500,
      cumNpp: -500,
    });
    expect(result.current.data.get('TSLA')).toMatchObject({
      cumNcp: 12345.67,
      cumNpp: -2222,
    });
    expect(result.current.error).toBeNull();
    expect(result.current.fetchedAt).not.toBeNull();
  });

  it('exposes error string on non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500));
    const { result } = renderHook(() =>
      useTickerNetFlowBatch({
        tickers: ['SPY'],
        date: '2026-05-07',
        marketOpen: true,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain('500');
    expect(result.current.data.size).toBe(0);
  });

  it('captures error message when fetch rejects', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network down'));
    const { result } = renderHook(() =>
      useTickerNetFlowBatch({
        tickers: ['SPY'],
        date: '2026-05-07',
        marketOpen: true,
      }),
    );
    await waitFor(() => expect(result.current.error).toBe('Network down'));
    expect(result.current.data.size).toBe(0);
  });

  it('polls every TICKER_NET_FLOW interval while marketOpen + non-empty', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(
      jsonResponse({
        date: '2026-05-07',
        requestedTickers: ['SPY'],
        count: 0,
        snapshots: [],
      }),
    );
    renderHook(() =>
      useTickerNetFlowBatch({
        tickers: ['SPY'],
        date: '2026-05-07',
        marketOpen: true,
      }),
    );
    // Eager mount fetch flushes microtasks.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // First polling tick.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVALS.TICKER_NET_FLOW);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Second polling tick.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVALS.TICKER_NET_FLOW);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not re-fetch when tickers array is referentially-new but value-equivalent', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(
      jsonResponse({
        date: '2026-05-07',
        requestedTickers: ['SPY'],
        count: 0,
        snapshots: [],
      }),
    );
    const { rerender } = renderHook(
      ({ tickers }: { tickers: string[] }) =>
        useTickerNetFlowBatch({
          tickers,
          date: '2026-05-07',
          marketOpen: true,
        }),
      { initialProps: { tickers: ['SPY', 'TSLA'] } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // New array, same canonical set: should not trigger.
    rerender({ tickers: ['TSLA', 'SPY'] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-fetches when the canonical ticker set actually changes', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(
      jsonResponse({
        date: '2026-05-07',
        requestedTickers: [],
        count: 0,
        snapshots: [],
      }),
    );
    const { rerender } = renderHook(
      ({ tickers }: { tickers: string[] }) =>
        useTickerNetFlowBatch({
          tickers,
          date: '2026-05-07',
          marketOpen: true,
        }),
      { initialProps: { tickers: ['SPY'] } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rerender({ tickers: ['SPY', 'AAPL'] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
