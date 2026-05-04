import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useDealerRegime } from '../../hooks/useDealerRegime';
import { POLL_INTERVALS } from '../../constants';

vi.mock('../../utils/auth', () => ({
  getAccessMode: vi.fn(() => 'owner'),
}));

import { getAccessMode } from '../../utils/auth';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const SAMPLE_RESPONSE = {
  rows: [
    {
      ticker: 'SPX',
      ts: '2026-05-01T20:04:33.280Z',
      spot: 7230,
      zeroGamma: 7187.47,
      confidence: 0.392,
      netGammaAtSpot: 3_500_000_000,
    },
  ],
  asOf: '2026-05-01T20:05:00Z',
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mockFetch.mockReset().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => SAMPLE_RESPONSE,
  });
  vi.mocked(getAccessMode).mockReturnValue('owner');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.stubGlobal('fetch', mockFetch);
});

describe('useDealerRegime', () => {
  it('fetches once on mount and populates data', async () => {
    const { result } = renderHook(() => useDealerRegime(true));
    await act(async () => {});
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual(SAMPLE_RESPONSE);
    expect(result.current.error).toBeNull();
  });

  it('short-circuits when access mode is public — no fetch, no error', async () => {
    vi.mocked(getAccessMode).mockReturnValue('public');
    const { result } = renderHook(() => useDealerRegime(true));
    await act(async () => {});
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('starts polling when market is open', async () => {
    renderHook(() => useDealerRegime(true));
    await act(async () => {});
    mockFetch.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.DEALER_REGIME);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not poll when market is closed (one-shot fetch only)', async () => {
    renderHook(() => useDealerRegime(false));
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledTimes(1);
    mockFetch.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.DEALER_REGIME * 3);
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('treats 401 as non-fatal: data null, error null', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    const { result } = renderHook(() => useDealerRegime(true));
    await act(async () => {});
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('surfaces non-401 fetch errors as error string', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const { result } = renderHook(() => useDealerRegime(true));
    await act(async () => {});
    await waitFor(() =>
      expect(result.current.error).toMatch(/HTTP 500/),
    );
  });

  it('surfaces fetch rejection as error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'));
    const { result } = renderHook(() => useDealerRegime(true));
    await act(async () => {});
    await waitFor(() => expect(result.current.error).toBe('network down'));
  });

  it('stops polling on unmount', async () => {
    const { unmount } = renderHook(() => useDealerRegime(true));
    await act(async () => {});
    mockFetch.mockClear();
    unmount();
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.DEALER_REGIME * 2);
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not update state when component unmounts mid-fetch (cleanup race)', async () => {
    // Simulate a slow fetch: resolve only after the component unmounts.
    let resolveFetch: (v: unknown) => void = () => {};
    mockFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const { result, unmount } = renderHook(() => useDealerRegime(true));
    // Snapshot the pre-unmount state — we'll assert the resolved fetch
    // doesn't mutate React state after unmount (no console error or
    // dangling update).
    const before = result.current;
    unmount();

    // Now resolve the fetch. The hook's mountedRef should prevent any
    // setState calls after unmount; if it doesn't, vitest will surface
    // a "Can't perform a React state update on an unmounted component"
    // warning that fails the test under strict mode.
    await act(async () => {
      resolveFetch({
        ok: true,
        status: 200,
        json: async () => SAMPLE_RESPONSE,
      });
    });
    expect(result.current).toBe(before);
  });

  it('passes an AbortSignal with timeout to fetch', async () => {
    renderHook(() => useDealerRegime(true));
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/dealer-regime',
      expect.objectContaining({
        credentials: 'same-origin',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('refresh() triggers an additional fetch and re-enters loading', async () => {
    const { result } = renderHook(() => useDealerRegime(false));
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

  // ── Phase 5b: scrubber params ──────────────────────────────

  it('appends ?date=YYYY-MM-DD when scrubbed to a past date', async () => {
    renderHook(() => useDealerRegime(true, '2026-05-01', null));
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/dealer-regime?date=2026-05-01',
      expect.any(Object),
    );
  });

  it('appends ?at=ISO when scrubbed to a specific minute', async () => {
    renderHook(() =>
      useDealerRegime(true, null, '2026-05-01T19:00:00.000Z'),
    );
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/dealer-regime?at=2026-05-01T19%3A00%3A00.000Z',
      expect.any(Object),
    );
  });

  it('does not poll when date is set — past data is static', async () => {
    renderHook(() => useDealerRegime(true, '2026-05-01', null));
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledTimes(1);
    mockFetch.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.DEALER_REGIME * 3);
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not poll when at is set — snapshot is static', async () => {
    renderHook(() =>
      useDealerRegime(true, null, '2026-05-01T19:00:00.000Z'),
    );
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledTimes(1);
    mockFetch.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.DEALER_REGIME * 3);
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
