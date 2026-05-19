import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useGreekFlow, type GreekFlowResponse } from '../../hooks/useGreekFlow';
import { POLL_INTERVALS } from '../../constants';

vi.mock('../../utils/auth', () => ({
  getAccessMode: vi.fn(() => 'owner'),
}));

import { getAccessMode } from '../../utils/auth';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const EMPTY_METRICS = {
  dir_vega_flow: emptyMetric(),
  total_vega_flow: emptyMetric(),
  otm_dir_vega_flow: emptyMetric(),
  otm_total_vega_flow: emptyMetric(),
  dir_delta_flow: emptyMetric(),
  total_delta_flow: emptyMetric(),
  otm_dir_delta_flow: emptyMetric(),
  otm_total_delta_flow: emptyMetric(),
};

const EMPTY_DIVERGENCE = {
  dir_vega_flow: emptyDivergence(),
  total_vega_flow: emptyDivergence(),
  otm_dir_vega_flow: emptyDivergence(),
  otm_total_vega_flow: emptyDivergence(),
  dir_delta_flow: emptyDivergence(),
  total_delta_flow: emptyDivergence(),
  otm_dir_delta_flow: emptyDivergence(),
  otm_total_delta_flow: emptyDivergence(),
};

const SAMPLE: GreekFlowResponse = {
  date: '2026-04-28',
  scope: '0dte',
  tickers: {
    SPY: { rows: [], metrics: EMPTY_METRICS },
    QQQ: { rows: [], metrics: EMPTY_METRICS },
  },
  divergence: EMPTY_DIVERGENCE,
  asOf: '2026-04-28T21:00:00.000Z',
};

function emptyMetric() {
  return {
    slope: { slope: null, points: 0 },
    flip: {
      occurred: false,
      atTimestamp: null,
      magnitude: 0,
      currentSign: 0 as const,
    },
    cliff: { magnitude: 0, atTimestamp: null },
  };
}

function emptyDivergence() {
  return { spySign: 0 as const, qqqSign: 0 as const, diverging: false };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mockFetch.mockReset().mockResolvedValue({
    ok: true,
    json: async () => SAMPLE,
  });
  vi.mocked(getAccessMode).mockReturnValue('owner');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.stubGlobal('fetch', mockFetch);
});

describe('useGreekFlow', () => {
  it('fetches initial data and populates state', async () => {
    const { result } = renderHook(() => useGreekFlow(true));
    await act(async () => {});
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual(SAMPLE);
    expect(result.current.error).toBeNull();
  });

  it('hits /api/greek-flow with default scope in live mode', async () => {
    renderHook(() => useGreekFlow(true));
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/greek-flow?scope=0dte',
      expect.any(Object),
    );
  });

  it('passes ?date=YYYY-MM-DD&scope=0dte in date mode', async () => {
    renderHook(() => useGreekFlow(false, '2026-04-25'));
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/greek-flow?date=2026-04-25&scope=0dte',
      expect.any(Object),
    );
  });

  it('passes scope=all when scope arg is "all"', async () => {
    renderHook(() => useGreekFlow(true, null, 'all'));
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/greek-flow?scope=all',
      expect.any(Object),
    );
  });

  it('short-circuits when access mode is public', async () => {
    vi.mocked(getAccessMode).mockReturnValue('public');
    const { result } = renderHook(() => useGreekFlow(true));
    await act(async () => {});
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('polls when market is open and no date is set', async () => {
    renderHook(() => useGreekFlow(true));
    await act(async () => {});
    mockFetch.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.GREEK_FLOW);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not poll when a date is selected (historical mode)', async () => {
    renderHook(() => useGreekFlow(true, '2026-04-25'));
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledTimes(1);
    mockFetch.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.GREEK_FLOW * 3);
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not poll when market is closed', async () => {
    renderHook(() => useGreekFlow(false));
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledTimes(1);
    mockFetch.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.GREEK_FLOW * 3);
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not surface a 401 as an error (public visitor path)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({}),
    });
    const { result } = renderHook(() => useGreekFlow(true));
    await act(async () => {});
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
  });

  it('reports a non-401 failure as an error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    const { result } = renderHook(() => useGreekFlow(true));
    await act(async () => {});
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Failed to load Greek flow');
  });

  it('aborts the in-flight request when date changes mid-flight', async () => {
    vi.useRealTimers();
    // First fetch hangs until aborted; date switch should fire
    // AbortError on the old controller and let the new fetch land.
    const abortRef: { signal: AbortSignal | null } = { signal: null };
    mockFetch.mockReset();
    mockFetch.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_, reject) => {
          abortRef.signal = init.signal ?? null;
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const winning: GreekFlowResponse = {
      ...SAMPLE,
      date: '2026-04-25',
      asOf: '2026-04-25T21:00:00.000Z',
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => winning,
    });

    const { result, rerender } = renderHook(
      ({ date }: { date: string | null }) => useGreekFlow(true, date),
      { initialProps: { date: null as string | null } },
    );

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    // Switch date — old AbortController must fire, new fetch lands.
    rerender({ date: '2026-04-25' });

    await waitFor(() => expect(result.current.data?.date).toBe('2026-04-25'));
    expect(result.current.error).toBeNull();
    expect(abortRef.signal?.aborted).toBe(true);
  });

  it('bails after fetch resolves if superseded by a newer date set', async () => {
    vi.useRealTimers();
    // First fetch resolves AFTER it has been superseded by the rerender.
    // The hook must check `ctrl.signal.aborted` between resolve and JSON
    // parse so the stale live-mode response can't clobber the winning
    // date-scoped state.
    let resolveFirst!: (value: unknown) => void;
    const aborts: AbortSignal[] = [];
    mockFetch.mockReset();
    mockFetch.mockImplementationOnce((_url: string, init: RequestInit) => {
      if (init.signal) aborts.push(init.signal);
      return new Promise((resolve) => {
        resolveFirst = resolve;
      });
    });
    const winning: GreekFlowResponse = {
      ...SAMPLE,
      date: '2026-04-25',
      asOf: '2026-04-25T21:00:00.000Z',
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => winning,
    });

    const { result, rerender } = renderHook(
      ({ date }: { date: string | null }) => useGreekFlow(true, date),
      { initialProps: { date: null as string | null } },
    );

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    rerender({ date: '2026-04-25' });
    await waitFor(() => expect(result.current.data?.date).toBe('2026-04-25'));
    expect(aborts[0]?.aborted).toBe(true);

    // Resolve the first fetch's body — hook should bail.
    const stale: GreekFlowResponse = {
      ...SAMPLE,
      date: '2026-01-01',
      asOf: '2026-01-01T21:00:00.000Z',
    };
    await act(async () => {
      resolveFirst({ ok: true, json: async () => stale });
      await Promise.resolve();
    });

    // Still showing winning date, not the stale resolved one.
    expect(result.current.data?.date).toBe('2026-04-25');
  });

  it('refresh() triggers an additional fetch and re-enters loading', async () => {
    const { result } = renderHook(() => useGreekFlow(false));
    await act(async () => {});
    await waitFor(() => expect(result.current.loading).toBe(false));
    mockFetch.mockClear();
    act(() => {
      result.current.refresh();
    });
    expect(result.current.loading).toBe(true);
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('aborts the in-flight request on unmount', async () => {
    vi.useRealTimers();
    const abortRef: { signal: AbortSignal | null } = { signal: null };
    mockFetch.mockReset();
    mockFetch.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise(() => {
          abortRef.signal = init.signal ?? null;
        }),
    );

    const { unmount } = renderHook(() => useGreekFlow(true));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(abortRef.signal?.aborted).toBe(false);

    unmount();
    expect(abortRef.signal?.aborted).toBe(true);
  });
});
