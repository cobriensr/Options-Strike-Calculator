import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useChainData } from '../../hooks/useChainData';
import type { ChainResponse } from '../../types/api';

// ============================================================
// MOCK DATA
// ============================================================

const mockChain: ChainResponse = {
  underlying: { symbol: '$SPX', price: 5700, prevClose: 5690 },
  expirationDate: '2026-03-14',
  daysToExpiration: 0,
  contractCount: 6,
  puts: [
    {
      strike: 5600,
      bid: 1.0,
      ask: 1.2,
      mid: 1.1,
      delta: -0.05,
      gamma: 0.005,
      theta: -0.5,
      vega: 0.1,
      iv: 0.22,
      volume: 100,
      oi: 500,
      itm: false,
    },
    {
      strike: 5650,
      bid: 2.5,
      ask: 3.0,
      mid: 2.75,
      delta: -0.1,
      gamma: 0.006,
      theta: -0.6,
      vega: 0.12,
      iv: 0.2,
      volume: 200,
      oi: 600,
      itm: false,
    },
  ],
  calls: [
    {
      strike: 5750,
      bid: 2.5,
      ask: 3.0,
      mid: 2.75,
      delta: 0.1,
      gamma: 0.006,
      theta: -0.6,
      vega: 0.12,
      iv: 0.2,
      volume: 200,
      oi: 600,
      itm: false,
    },
    {
      strike: 5800,
      bid: 1.0,
      ask: 1.2,
      mid: 1.1,
      delta: 0.05,
      gamma: 0.005,
      theta: -0.5,
      vega: 0.1,
      iv: 0.22,
      volume: 100,
      oi: 500,
      itm: false,
    },
  ],
  targetDeltas: {
    5: {
      putStrike: 5600,
      callStrike: 5800,
      putDelta: -0.05,
      callDelta: 0.05,
      putIV: 0.22,
      callIV: 0.22,
      putBid: 1.0,
      putAsk: 1.2,
      callBid: 1.0,
      callAsk: 1.2,
      putMid: 1.1,
      callMid: 1.1,
      icCredit: 2.2,
      width: 200,
    },
  },
  asOf: '2026-03-14T15:00:00Z',
};

// ============================================================
// HELPERS
// ============================================================

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    }),
  );
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ============================================================
// TESTS
// ============================================================

describe('useChainData', () => {
  it('does not fetch when disabled', async () => {
    const fetchMock = mockFetch(200, mockChain);

    const { result } = renderHook(() => useChainData(false, false));

    // Give it a tick to ensure no fetch fires
    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.chain).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('fetches chain data on mount when enabled', async () => {
    mockFetch(200, mockChain);

    const { result } = renderHook(() => useChainData(true, false));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.chain).toEqual(mockChain);
    expect(result.current.error).toBeNull();
  });

  it('returns null for 401 (public visitor)', async () => {
    mockFetch(401, { error: 'Not authenticated' });

    const { result } = renderHook(() => useChainData(true, false));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.chain).toBeNull();
  });

  it('returns null for non-ok response', async () => {
    mockFetch(500, { error: 'Internal error' });

    const { result } = renderHook(() => useChainData(true, false));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.chain).toBeNull();
  });

  it('returns null on network error', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error('Network error')),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => useChainData(true, false));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.chain).toBeNull();
  });

  it('sets error when response contains error field', async () => {
    const errorResponse = {
      error: 'No 0DTE contracts found. Market may be closed.',
      underlying: null,
      puts: [],
      calls: [],
      targetDeltas: {},
      asOf: '2026-03-14T20:00:00Z',
    };
    mockFetch(200, errorResponse);

    const { result } = renderHook(() => useChainData(true, false));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe(
      'No 0DTE contracts found. Market may be closed.',
    );
    // The hook now keeps data in state even when it contains an error field
    expect(result.current.chain).toEqual(errorResponse);
  });

  it('does not auto-refresh when market is closed', async () => {
    const fetchMock = mockFetch(200, mockChain);

    const { result } = renderHook(() => useChainData(true, false));

    await waitFor(() => expect(result.current.loading).toBe(false));

    const initialCalls = fetchMock.mock.calls.length;
    expect(initialCalls).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });

    // No additional calls — market is closed
    expect(fetchMock.mock.calls.length).toBe(initialCalls);
  });

  it('auto-refreshes every 60s when market is open', async () => {
    const fetchMock = mockFetch(200, mockChain);

    const { result } = renderHook(() => useChainData(true, true));

    await waitFor(() => expect(result.current.loading).toBe(false));

    const initialCalls = fetchMock.mock.calls.length;
    expect(initialCalls).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThan(initialCalls),
    );
  });

  it('cleans up interval on unmount', async () => {
    const fetchMock = mockFetch(200, mockChain);

    const { result, unmount } = renderHook(() => useChainData(true, true));

    await waitFor(() => expect(result.current.loading).toBe(false));

    const callsAfterMount = fetchMock.mock.calls.length;
    unmount();

    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });

    expect(fetchMock.mock.calls.length).toBe(callsAfterMount);
  });

  it('refresh() triggers a re-fetch', async () => {
    const fetchMock = mockFetch(200, mockChain);

    const { result } = renderHook(() => useChainData(true, false));

    await waitFor(() => expect(result.current.loading).toBe(false));

    const callsBefore = fetchMock.mock.calls.length;

    act(() => {
      result.current.refresh();
    });

    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });

  it('refresh() is a no-op when disabled', async () => {
    const fetchMock = mockFetch(200, mockChain);

    const { result } = renderHook(() => useChainData(false, false));

    act(() => {
      result.current.refresh();
    });

    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
