import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useNopeIntraday } from '../../hooks/useNopeIntraday';
import { POLL_INTERVALS } from '../../constants';

vi.mock('../../utils/auth', () => ({
  checkIsOwner: vi.fn(() => true),
}));

import { checkIsOwner } from '../../utils/auth';

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
  vi.mocked(checkIsOwner).mockReturnValue(true);
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
    vi.mocked(checkIsOwner).mockReturnValue(false);
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
    // Start as owner, then switch checkIsOwner to false. Effect will re-run
    // and early return, verifying the ownership gate in the polling path.
    const { rerender } = renderHook(() =>
      useNopeIntraday({ marketOpen: true }),
    );
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledTimes(1);

    vi.mocked(checkIsOwner).mockReturnValue(false);
    rerender();
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.NOPE * 3);
    });

    // No additional fetches — both effects gate on isOwner.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ── Malformed payload validation ─────────────────────────────
// The parse used to be `(await res.json()) as NopeIntradayResponse`, so a
// shapeless body put a non-array into `points` and PriceChart's NOPE
// overlay died at `nopePoints.map`. Validation now happens at the parse.

describe('useNopeIntraday: malformed payloads', () => {
  it('reports a shape error and keeps an empty overlay on a {} body', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    const { result } = renderHook(() => useNopeIntraday({ marketOpen: true }));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toMatch(/unexpected response shape/i);
    expect(result.current.points).toEqual([]);
    expect(result.current.date).toBeNull();
  });

  it('keeps the last-known-good overlay when a later poll goes malformed', async () => {
    // Matches the hook's existing network-failure behavior: surface the
    // error, keep showing the last points the chart successfully drew.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => SAMPLE_RESPONSE,
    });

    const { result } = renderHook(() => useNopeIntraday({ marketOpen: true }));
    await waitFor(() => expect(result.current.points).toHaveLength(2));
    const goodPoints = result.current.points;

    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.NOPE + 10);
    });

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.points).toBe(goodPoints);
    expect(result.current.date).toBe('2026-04-14');
  });

  it('reports a shape error when points is a non-array scalar', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ...SAMPLE_RESPONSE, points: 'garbage' }),
    });

    const { result } = renderHook(() => useNopeIntraday({ marketOpen: true }));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.points).toEqual([]);
  });

  it('reports a shape error on an HTML-ish string body', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => '<!doctype html><html>oops</html>',
    });

    const { result } = renderHook(() => useNopeIntraday({ marketOpen: true }));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.points).toEqual([]);
  });

  it('drops malformed points and keeps the valid ones', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        ...SAMPLE_RESPONSE,
        points: [
          SAMPLE_RESPONSE.points[0],
          'garbage',
          { timestamp: 'not-a-date', nope: 1, nope_fill: 1 },
          { timestamp: '2026-04-14T13:32:00.000Z', nope: null, nope_fill: 0 },
          SAMPLE_RESPONSE.points[1],
        ],
      }),
    });

    const { result } = renderHook(() => useNopeIntraday({ marketOpen: true }));

    await waitFor(() => expect(result.current.points).toHaveLength(2));
    expect(result.current.points).toEqual(SAMPLE_RESPONSE.points);
    expect(result.current.error).toBeNull();
  });

  it('keeps a referentially stable empty array across repeated bad polls', async () => {
    // PriceChart mirrors `points` into a setData effect keyed on the array
    // reference; a fresh [] each poll would re-fire it forever (the
    // GexLandscape render-loop lesson).
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    const { result } = renderHook(() => useNopeIntraday({ marketOpen: true }));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    const firstPoints = result.current.points;

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.NOPE + 10);
    });
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.NOPE + 10);
    });

    expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
    expect(result.current.points).toBe(firstPoints);
  });
});
