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
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/zero-gamma?ticker=SPX&date=2026-04-23',
      expect.any(Object),
    );
  });
});
