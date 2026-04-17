import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useNopeIntraday } from '../../hooks/useNopeIntraday';
import { POLL_INTERVALS } from '../../constants';

vi.mock('../../hooks/useIsOwner', () => ({
  useIsOwner: vi.fn(() => true),
}));

import { useIsOwner } from '../../hooks/useIsOwner';

const SAMPLE_RESPONSE = {
  ticker: 'SPY',
  date: '2026-04-14',
  availableDates: ['2026-04-13', '2026-04-14'],
  points: [
    {
      timestamp: '2026-04-14T13:30:00.000Z',
      nope: -0.000648,
      nope_fill: -0.000434,
    },
    {
      timestamp: '2026-04-14T13:31:00.000Z',
      nope: 0.000123,
      nope_fill: 0.000099,
    },
  ],
};

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mockFetch.mockReset().mockResolvedValue({
    ok: true,
    json: async () => SAMPLE_RESPONSE,
  });
  vi.mocked(useIsOwner).mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.stubGlobal('fetch', mockFetch);
});

// ── Initial state ────────────────────────────────────────────

describe('useNopeIntraday: initial state', () => {
  it('returns empty points initially', () => {
    const { result } = renderHook(() => useNopeIntraday({ marketOpen: true }));
    expect(result.current.points).toEqual([]);
    expect(result.current.date).toBeNull();
    expect(result.current.error).toBeNull();
  });
});

// ── Fetching ─────────────────────────────────────────────────

describe('useNopeIntraday: fetching', () => {
  it('fetches on mount when owner', async () => {
    renderHook(() => useNopeIntraday({ marketOpen: true }));
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]![0]).toBe('/api/nope-intraday');
  });

  it('populates points and date from response', async () => {
    const { result } = renderHook(() => useNopeIntraday({ marketOpen: true }));
    await waitFor(() => expect(result.current.points).toHaveLength(2));
    expect(result.current.date).toBe('2026-04-14');
    expect(result.current.points[0]!.nope).toBeCloseTo(-0.000648, 10);
  });

  it('skips fetch when not owner', async () => {
    vi.mocked(useIsOwner).mockReturnValue(false);
    renderHook(() => useNopeIntraday({ marketOpen: true }));
    await act(async () => {});
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('records error message when fetch fails', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const { result } = renderHook(() => useNopeIntraday({ marketOpen: true }));
    await waitFor(() => expect(result.current.error).toContain('500'));
    expect(result.current.points).toEqual([]);
  });

  it('keeps points when network rejects', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network down'));
    const { result } = renderHook(() => useNopeIntraday({ marketOpen: true }));
    await waitFor(() => expect(result.current.error).toBe('Network down'));
    expect(result.current.points).toEqual([]);
  });
});

// ── Polling ──────────────────────────────────────────────────

describe('useNopeIntraday: polling', () => {
  it('polls at NOPE cadence while market is open', async () => {
    renderHook(() => useNopeIntraday({ marketOpen: true }));
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.NOPE);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.NOPE);
    });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('does not poll when market closed', async () => {
    renderHook(() => useNopeIntraday({ marketOpen: false }));
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledTimes(1); // initial fetch still runs

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.NOPE * 5);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1); // no additional polls
  });

  it('cleans up interval on unmount', async () => {
    const { unmount } = renderHook(() => useNopeIntraday({ marketOpen: true }));
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.NOPE * 3);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ── Unmount guard branches ───────────────────────────────────

describe('useNopeIntraday: unmount guards', () => {
  it('does not setState when fetch resolves after unmount', async () => {
    // Hold the fetch promise open so we can resolve it post-unmount.
    let resolveFetch: (v: unknown) => void = () => {};
    const pending = new Promise<unknown>((res) => {
      resolveFetch = res;
    });
    mockFetch.mockReturnValueOnce(pending);

    const { result, unmount } = renderHook(() =>
      useNopeIntraday({ marketOpen: true }),
    );
    unmount();

    // Resolve fetch post-unmount — setState paths should early-return.
    resolveFetch({
      ok: true,
      json: async () => SAMPLE_RESPONSE,
    });
    await act(async () => {
      vi.advanceTimersByTime(50);
    });

    // State remained initial empty — late setState bailed out.
    expect(result.current.points).toEqual([]);
    expect(result.current.date).toBeNull();
  });

  it('does not set error when fetch rejects after unmount', async () => {
    let rejectFetch: (err: Error) => void = () => {};
    const pending = new Promise<unknown>((_resolve, reject) => {
      rejectFetch = reject;
    });
    mockFetch.mockReturnValueOnce(pending);

    const { result, unmount } = renderHook(() =>
      useNopeIntraday({ marketOpen: true }),
    );
    unmount();

    rejectFetch(new Error('late fail'));
    await act(async () => {
      vi.advanceTimersByTime(50);
    });

    expect(result.current.error).toBeNull();
  });

  it('flips ownership after mount to non-owner does not trigger fetch from fetchPoints', async () => {
    // Start as owner, then switch useIsOwner to false. Effect will re-run
    // and early return, verifying the ownership gate in the polling path.
    const { rerender } = renderHook(() =>
      useNopeIntraday({ marketOpen: true }),
    );
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledTimes(1);

    vi.mocked(useIsOwner).mockReturnValue(false);
    rerender();
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.NOPE * 3);
    });

    // No additional fetches — both effects gate on isOwner.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
