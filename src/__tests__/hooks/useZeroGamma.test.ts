import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useZeroGamma } from '../../hooks/useZeroGamma';
import { POLL_INTERVALS } from '../../constants';

vi.mock('../../utils/auth', () => ({
  getAccessMode: vi.fn(() => 'owner'),
}));

import { getAccessMode } from '../../utils/auth';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const SAMPLE_LATEST = {
  ticker: 'SPX',
  spot: 7135.5,
  zeroGamma: 7150.25,
  confidence: 0.72,
  netGammaAtSpot: -1.2e9,
  gammaCurve: null,
  ts: '2026-04-28T20:10:00.000Z',
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mockFetch.mockReset().mockResolvedValue({
    ok: true,
    json: async () => ({ latest: SAMPLE_LATEST, history: [SAMPLE_LATEST] }),
  });
  vi.mocked(getAccessMode).mockReturnValue('owner');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.stubGlobal('fetch', mockFetch);
});

// useDebounced's default delay: how long a changed date waits before refetching.
const SETTLE_MS = 250;

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('useZeroGamma', () => {
  it('fetches initial data and populates latest + history', async () => {
    const { result } = renderHook(() => useZeroGamma('SPX', true));
    await act(async () => {});
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.latest).toEqual(SAMPLE_LATEST);
    expect(result.current.history).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it('passes the ticker query param to the endpoint', async () => {
    const { result } = renderHook(() => useZeroGamma('NDX', true));
    await act(async () => {});
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/zero-gamma?ticker=NDX',
      expect.any(Object),
    );
  });

  it('short-circuits when access mode is public', async () => {
    vi.mocked(getAccessMode).mockReturnValue('public');
    const { result } = renderHook(() => useZeroGamma('SPX', true));
    await act(async () => {});
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.latest).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('starts polling when market is open', async () => {
    renderHook(() => useZeroGamma('SPX', true));
    await act(async () => {});
    mockFetch.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.ZERO_GAMMA);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not poll when market is closed (one-shot fetch only)', async () => {
    renderHook(() => useZeroGamma('SPX', false));
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledTimes(1);
    mockFetch.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.ZERO_GAMMA * 3);
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refetches when ticker changes', async () => {
    const { rerender } = renderHook(
      ({ t }: { t: string }) => useZeroGamma(t, true),
      { initialProps: { t: 'SPX' } },
    );
    await act(async () => {});
    mockFetch.mockClear();
    rerender({ t: 'NDX' });
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/zero-gamma?ticker=NDX',
      expect.any(Object),
    );
  });

  it('does not surface 401 as user-visible error', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    const { result } = renderHook(() => useZeroGamma('SPX', true));
    await act(async () => {});
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
  });

  it('surfaces non-401 fetch errors', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const { result } = renderHook(() => useZeroGamma('SPX', true));
    await act(async () => {});
    await waitFor(() =>
      expect(result.current.error).toBe('Failed to load zero-gamma data'),
    );
  });

  it('surfaces fetch rejection as error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'));
    const { result } = renderHook(() => useZeroGamma('SPX', true));
    await act(async () => {});
    await waitFor(() => expect(result.current.error).toBe('network down'));
  });

  it('stops polling on unmount', async () => {
    const { unmount } = renderHook(() => useZeroGamma('SPX', true));
    await act(async () => {});
    mockFetch.mockClear();
    unmount();
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.ZERO_GAMMA * 2);
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('appends ?date=YYYY-MM-DD when scrubbed to a past date', async () => {
    renderHook(() => useZeroGamma('SPX', true, '2026-04-22'));
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/zero-gamma?ticker=SPX&date=2026-04-22',
      expect.any(Object),
    );
  });

  it('does not poll when scrubbed to a date — past data is static', async () => {
    renderHook(() => useZeroGamma('SPX', true, '2026-04-22'));
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledTimes(1);
    mockFetch.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.ZERO_GAMMA * 3);
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refetches when the date prop changes', async () => {
    const { rerender } = renderHook(
      ({ d }: { d: string | null }) => useZeroGamma('SPX', true, d),
      { initialProps: { d: '2026-04-22' as string | null } },
    );
    await act(async () => {});
    mockFetch.mockClear();
    rerender({ d: '2026-04-23' });
    await advance(SETTLE_MS);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/zero-gamma?ticker=SPX&date=2026-04-23',
      expect.any(Object),
    );
  });

  it('aborts the in-flight request when the ticker changes mid-flight', async () => {
    const aborts: AbortSignal[] = [];
    // First fetch: never resolves until aborted, captures its signal.
    mockFetch.mockReset().mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_, reject) => {
          if (init.signal) aborts.push(init.signal);
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    // Second fetch resolves with NDX data.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        latest: { ...SAMPLE_LATEST, ticker: 'NDX' },
        history: [{ ...SAMPLE_LATEST, ticker: 'NDX' }],
      }),
    });

    const { result, rerender } = renderHook(
      ({ ticker }: { ticker: string }) => useZeroGamma(ticker, true),
      { initialProps: { ticker: 'SPX' } },
    );
    await waitFor(() => expect(result.current.loading).toBe(true));

    rerender({ ticker: 'NDX' });
    await waitFor(() => expect(result.current.latest?.ticker).toBe('NDX'));
    expect(aborts[0]?.aborted).toBe(true);
  });

  it('aborts the in-flight request on unmount', async () => {
    const aborts: AbortSignal[] = [];
    mockFetch.mockReset().mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise(() => {
          if (init.signal) aborts.push(init.signal);
        }),
    );
    const { unmount } = renderHook(() => useZeroGamma('SPX', true));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(aborts[0]?.aborted).toBe(false);
    unmount();
    expect(aborts[0]?.aborted).toBe(true);
  });
});

describe('useZeroGamma date settling', () => {
  interface PendingFetch {
    url: string;
    signal: AbortSignal;
    resolve: (payload: unknown) => void;
  }

  /**
   * Every fetch stays pending until the test resolves it. With `honorAbort`
   * it rejects with an AbortError when its signal aborts, like a real fetch;
   * without it the response can still arrive after the abort, so the tests
   * can check the hook never writes it to state.
   */
  function stubPendingFetch(honorAbort: boolean): PendingFetch[] {
    const calls: PendingFetch[] = [];
    mockFetch.mockReset().mockImplementation(
      (url: string, init: RequestInit) =>
        new Promise((resolve, reject) => {
          const signal = init.signal as AbortSignal;
          if (honorAbort) {
            signal.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }
          calls.push({
            url,
            signal,
            resolve: (payload) =>
              resolve({ ok: true, json: async () => payload }),
          });
        }),
    );
    return calls;
  }

  async function respond(call: PendingFetch, ts: string): Promise<void> {
    const row = { ...SAMPLE_LATEST, ts };
    await act(async () => {
      call.resolve({ latest: row, history: [row] });
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  const urls = () => mockFetch.mock.calls.map((c) => c[0] as string);

  function renderDated(initial: string | null) {
    return renderHook(
      ({ d }: { d: string | null }) => useZeroGamma('SPX', true, d),
      { initialProps: { d: initial } },
    );
  }

  it('fetches on mount without waiting for the delay', async () => {
    renderDated('2026-04-22');
    await act(async () => {});
    expect(urls()).toEqual(['/api/zero-gamma?ticker=SPX&date=2026-04-22']);
  });

  it('refetches once per ticker for a burst of date changes', async () => {
    const { rerender } = renderHook(
      ({ d }: { d: string | null }) => [
        useZeroGamma('SPX', true, d),
        useZeroGamma('NDX', true, d),
        useZeroGamma('SPY', true, d),
      ],
      { initialProps: { d: '2026-04-20' as string | null } },
    );
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledTimes(3);
    mockFetch.mockClear();

    for (const d of ['2026-04-21', '2026-04-22', '2026-04-23']) {
      rerender({ d });
      await advance(SETTLE_MS - 50);
    }
    // Each step came inside the previous one's window: nothing yet.
    expect(mockFetch).not.toHaveBeenCalled();

    await advance(50);
    expect(urls().sort()).toEqual([
      '/api/zero-gamma?ticker=NDX&date=2026-04-23',
      '/api/zero-gamma?ticker=SPX&date=2026-04-23',
      '/api/zero-gamma?ticker=SPY&date=2026-04-23',
    ]);

    await advance(SETTLE_MS * 4);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('refetches again for a date change after the window', async () => {
    const { rerender } = renderDated('2026-04-20');
    await act(async () => {});
    mockFetch.mockClear();

    rerender({ d: '2026-04-21' });
    await advance(SETTLE_MS);
    expect(urls()).toEqual(['/api/zero-gamma?ticker=SPX&date=2026-04-21']);

    rerender({ d: '2026-04-22' });
    await advance(SETTLE_MS);
    expect(urls()).toEqual([
      '/api/zero-gamma?ticker=SPX&date=2026-04-21',
      '/api/zero-gamma?ticker=SPX&date=2026-04-22',
    ]);
  });

  it('drops a pending date change when unmounted', async () => {
    const { rerender, unmount } = renderDated('2026-04-20');
    await act(async () => {});
    mockFetch.mockClear();

    rerender({ d: '2026-04-21' });
    unmount();
    await advance(SETTLE_MS * 2);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('aborts the superseded request and ignores its response when it arrives before the new one', async () => {
    const calls = stubPendingFetch(false);
    const { result, rerender } = renderDated('2026-04-22');
    await act(async () => {});
    expect(calls).toHaveLength(1);

    rerender({ d: '2026-04-23' });
    await advance(SETTLE_MS);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(calls[1]?.signal.aborted).toBe(false);

    await respond(calls[0]!, '2026-04-22T20:10:00.000Z');
    expect(result.current.latest).toBeNull();
    expect(result.current.loading).toBe(true);

    await respond(calls[1]!, '2026-04-23T20:10:00.000Z');
    expect(result.current.latest?.ts).toBe('2026-04-23T20:10:00.000Z');
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('does not let a superseded response replace newer data', async () => {
    const calls = stubPendingFetch(false);
    const { result, rerender } = renderDated('2026-04-22');
    await act(async () => {});

    rerender({ d: '2026-04-23' });
    await advance(SETTLE_MS);
    await respond(calls[1]!, '2026-04-23T20:10:00.000Z');

    await respond(calls[0]!, '2026-04-22T20:10:00.000Z');

    expect(result.current.latest?.ts).toBe('2026-04-23T20:10:00.000Z');
    expect(result.current.error).toBeNull();
  });

  it('sets no error when the superseded request rejects as aborted', async () => {
    const calls = stubPendingFetch(true);
    const { result, rerender } = renderDated('2026-04-22');
    await act(async () => {});

    rerender({ d: '2026-04-23' });
    await advance(SETTLE_MS);
    expect(calls[0]?.signal.aborted).toBe(true);
    await respond(calls[1]!, '2026-04-23T20:10:00.000Z');

    expect(result.current.error).toBeNull();
    expect(result.current.latest?.ts).toBe('2026-04-23T20:10:00.000Z');
  });

  it('stops polling once a scrubbed date has settled', async () => {
    const { rerender } = renderDated(null);
    await act(async () => {});
    rerender({ d: '2026-04-22' });
    await advance(SETTLE_MS);
    mockFetch.mockClear();

    await advance(POLL_INTERVALS.ZERO_GAMMA * 2);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('resumes polling when the date returns to live', async () => {
    const { rerender } = renderDated('2026-04-22');
    await act(async () => {});
    rerender({ d: null });
    await advance(SETTLE_MS);
    expect(urls().at(-1)).toBe('/api/zero-gamma?ticker=SPX');
    mockFetch.mockClear();

    await advance(POLL_INTERVALS.ZERO_GAMMA);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
