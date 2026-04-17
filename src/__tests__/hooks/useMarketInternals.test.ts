import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useMarketInternals } from '../../hooks/useMarketInternals';
import { POLL_INTERVALS } from '../../constants';
import type { InternalBar } from '../../types/market-internals';

function buildResponse(bars: InternalBar[], asOf = '2026-04-15T18:00:00Z') {
  return {
    ok: true,
    json: async () => ({ bars, asOf, marketOpen: true }),
  } as unknown as Response;
}

const tickBar = (ts: string, close: number): InternalBar => ({
  ts,
  symbol: '$TICK',
  open: close,
  high: close,
  low: close,
  close,
});

const addBar = (ts: string, close: number): InternalBar => ({
  ts,
  symbol: '$ADD',
  open: close,
  high: close,
  low: close,
  close,
});

/**
 * Flush microtasks so the in-flight fetch promise resolves and setState
 * commits run before assertions. Uses real timers — callers that want
 * to advance the 60s poll interval use vi.advanceTimersByTimeAsync.
 */
async function flushPromises(): Promise<void> {
  // Three microtask boundaries cover the fetch → res.json() → setState chain.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useMarketInternals', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fetches once on mount and exposes bars + latestBySymbol', async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse([
        tickBar('2026-04-15T17:58:00Z', 120),
        tickBar('2026-04-15T17:59:00Z', 450),
        addBar('2026-04-15T17:59:00Z', 1200),
      ]),
    );

    const { result } = renderHook(() =>
      useMarketInternals({ marketOpen: true }),
    );

    await flushPromises();

    expect(result.current.loading).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/market-internals/history');
    expect(result.current.bars).toHaveLength(3);
    expect(result.current.latestBySymbol.$TICK?.close).toBe(450);
    expect(result.current.latestBySymbol.$ADD?.close).toBe(1200);
    expect(result.current.latestBySymbol.$VOLD).toBeNull();
    expect(result.current.latestBySymbol.$TRIN).toBeNull();
    expect(result.current.asOf).toBe('2026-04-15T18:00:00Z');
    expect(result.current.error).toBeNull();
  });

  it('polls every 60s while marketOpen is true', async () => {
    fetchMock
      .mockResolvedValueOnce(
        buildResponse([tickBar('2026-04-15T17:59:00Z', 100)]),
      )
      .mockResolvedValueOnce(
        buildResponse([tickBar('2026-04-15T18:00:00Z', 200)]),
      )
      .mockResolvedValueOnce(
        buildResponse([tickBar('2026-04-15T18:01:00Z', 300)]),
      );

    renderHook(() => useMarketInternals({ marketOpen: true }));

    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not poll when marketOpen is false (single fetch on mount)', async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse([tickBar('2026-04-15T20:00:00Z', 50)]),
    );

    renderHook(() => useMarketInternals({ marketOpen: false }));

    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000 * 5);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces fetch errors without clearing prior bars', async () => {
    fetchMock
      .mockResolvedValueOnce(
        buildResponse([tickBar('2026-04-15T17:59:00Z', 100)]),
      )
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({}),
      } as unknown as Response);

    const { result } = renderHook(() =>
      useMarketInternals({ marketOpen: true }),
    );

    await flushPromises();
    expect(result.current.bars).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await flushPromises();

    expect(result.current.error).not.toBeNull();
    expect(result.current.error).toMatch(/HTTP 503/);
    // Stale bars preserved across the failing refetch.
    expect(result.current.bars).toHaveLength(1);
  });

  it('handles non-HTTP errors with a default message', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const { result } = renderHook(() =>
      useMarketInternals({ marketOpen: true }),
    );

    await flushPromises();

    expect(result.current.error).not.toBeNull();
    expect(result.current.error).toMatch(/Failed to fetch/);
  });

  it('swallows AbortError without setting error state', async () => {
    // First resolved response so we get past the initial fetch.
    fetchMock.mockResolvedValueOnce(
      buildResponse([tickBar('2026-04-15T17:59:00Z', 100)]),
    );
    // Second fetch rejects with AbortError.
    fetchMock.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));

    const { result } = renderHook(() =>
      useMarketInternals({ marketOpen: true }),
    );

    await flushPromises();
    expect(result.current.error).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await flushPromises();

    // AbortError should NOT populate the error state.
    expect(result.current.error).toBeNull();
  });

  it('does not setState when fetch resolves after unmount', async () => {
    // Hold the fetch promise open.
    let resolveFetch: (v: Response) => void = () => {};
    const pending = new Promise<Response>((res) => {
      resolveFetch = res;
    });
    fetchMock.mockReturnValueOnce(pending);

    const { result, unmount } = renderHook(() =>
      useMarketInternals({ marketOpen: true }),
    );

    unmount();

    resolveFetch(buildResponse([tickBar('2026-04-15T18:00:00Z', 999)]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // Bars remain empty since setState bailed after unmount.
    expect(result.current.bars).toEqual([]);
    expect(result.current.asOf).toBeNull();
  });

  it('does not setState when fetch rejects after unmount', async () => {
    let rejectFetch: (err: Error) => void = () => {};
    const pending = new Promise<Response>((_res, rej) => {
      rejectFetch = rej;
    });
    fetchMock.mockReturnValueOnce(pending);

    const { result, unmount } = renderHook(() =>
      useMarketInternals({ marketOpen: true }),
    );

    unmount();

    rejectFetch(new Error('late fail'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(result.current.error).toBeNull();
  });

  it('cancels in-flight fetch and stops polling after unmount', async () => {
    // Spy on AbortController.abort so we can assert the cleanup path
    // fired (covers the "cancel in-flight fetch" half of the contract).
    const abortSpy = vi.spyOn(AbortController.prototype, 'abort');

    fetchMock.mockResolvedValue(
      buildResponse([tickBar('2026-04-15T17:59:00Z', 100)]),
    );

    const { unmount } = renderHook(() =>
      useMarketInternals({ marketOpen: true }),
    );

    // Initial mount fetch must resolve before we unmount — otherwise
    // we're asserting polling never started in the first place.
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    unmount();

    // Cleanup aborts the most recent controller.
    expect(abortSpy).toHaveBeenCalled();

    // Advance past 2 full poll intervals — the cleared interval must
    // not fire any further fetches.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVALS.MARKET_INTERNALS * 2);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    abortSpy.mockRestore();
  });
});
