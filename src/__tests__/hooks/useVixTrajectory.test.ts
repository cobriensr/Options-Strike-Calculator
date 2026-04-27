import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  deriveTrajectory,
  useVixTrajectory,
  type VixSnapshot,
} from '../../hooks/useVixTrajectory';
import { POLL_INTERVALS } from '../../constants';

vi.mock('../../utils/auth', () => ({
  checkIsOwner: vi.fn(() => true),
}));

import { checkIsOwner } from '../../utils/auth';

function snap(overrides: Partial<VixSnapshot>): VixSnapshot {
  return {
    entryTime: '9:30 AM',
    vix: 17,
    vix1d: 13,
    vix9d: 16,
    spx: 6900,
    ...overrides,
  };
}

describe('deriveTrajectory', () => {
  it('returns hasData=false on no input', () => {
    const state = deriveTrajectory([]);
    expect(state.hasData).toBe(true);
    expect(state.ratio1d).toBeNull();
    expect(state.ratio9d).toBeNull();
    expect(state.spx).toBeNull();
  });

  it('returns null trajectories when only one snapshot exists', () => {
    const state = deriveTrajectory([snap({ entryTime: '11:45 AM' })]);
    expect(state.hasData).toBe(true);
    expect(state.ratio9d).toBeNull();
  });

  it('computes signed delta for ratio9d over a valid window', () => {
    const state = deriveTrajectory([
      snap({ entryTime: '11:30 AM', vix: 17, vix9d: 14.45 }), // 0.85
      snap({ entryTime: '11:45 AM', vix: 17, vix9d: 16.15 }), // 0.95
    ]);
    expect(state.ratio9d).not.toBeNull();
    expect(state.ratio9d!.spanMin).toBe(15);
    expect(state.ratio9d!.delta).toBeCloseTo(0.1, 2);
  });

  it('rejects windows shorter than the minimum span', () => {
    const state = deriveTrajectory([
      snap({ entryTime: '11:40 AM', vix: 17, vix9d: 16 }),
      snap({ entryTime: '11:45 AM', vix: 17, vix9d: 16.5 }),
    ]);
    expect(state.ratio9d).toBeNull();
  });

  it('rejects windows longer than the maximum span', () => {
    const state = deriveTrajectory([
      snap({ entryTime: '11:00 AM', vix: 17, vix9d: 16 }),
      snap({ entryTime: '11:45 AM', vix: 17, vix9d: 16.5 }),
    ]);
    expect(state.ratio9d).toBeNull();
  });

  it('picks the baseline closest to but not exceeding the target', () => {
    // latest at 11:45, target = 11:30. Pick 11:32 (t=692, ≤ target=690?
    // 11:32 = 692; target = 11:45 - 15 = 11:30 = 690 → 692 > 690, skip.
    // Next: 11:28 = 688, ≤ 690 → pick. span = 17 min.
    const state = deriveTrajectory([
      snap({ entryTime: '11:28 AM', vix: 17, vix9d: 16 }),
      snap({ entryTime: '11:32 AM', vix: 17, vix9d: 16.2 }),
      snap({ entryTime: '11:45 AM', vix: 17, vix9d: 16.5 }),
    ]);
    expect(state.ratio9d).not.toBeNull();
    expect(state.ratio9d!.spanMin).toBe(17);
    expect(state.ratio9d!.delta).toBeCloseTo(16.5 / 17 - 16 / 17, 4);
  });

  it('skips snapshots with null vix1d when computing ratio1d', () => {
    const state = deriveTrajectory([
      snap({ entryTime: '11:30 AM', vix1d: null, vix9d: 16 }),
      snap({ entryTime: '11:45 AM', vix1d: 13, vix9d: 16.5 }),
    ]);
    expect(state.ratio1d).toBeNull();
    expect(state.ratio9d).not.toBeNull();
  });

  it('skips snapshots with malformed entryTime', () => {
    const state = deriveTrajectory([
      snap({ entryTime: 'garbage', vix9d: 16 }),
      snap({ entryTime: '11:30 AM', vix9d: 16 }),
      snap({ entryTime: '11:45 AM', vix9d: 16.5 }),
    ]);
    expect(state.ratio9d).not.toBeNull();
    expect(state.ratio9d!.spanMin).toBe(15);
  });

  it('computes SPX delta independently from ratio deltas', () => {
    const state = deriveTrajectory([
      snap({ entryTime: '11:30 AM', spx: 6900 }),
      snap({ entryTime: '11:45 AM', spx: 6960 }),
    ]);
    expect(state.spx).not.toBeNull();
    expect(state.spx!.delta).toBeCloseTo(60, 2);
    expect(state.spx!.spanMin).toBe(15);
  });

  it('returns null SPX when all spx values are missing', () => {
    const state = deriveTrajectory([
      snap({ entryTime: '11:30 AM', spx: null }),
      snap({ entryTime: '11:45 AM', spx: null }),
    ]);
    expect(state.spx).toBeNull();
  });
});

// ============================================================
// HOOK: useVixTrajectory (exercises fetch + polling branches)
// ============================================================

describe('useVixTrajectory hook', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.mocked(checkIsOwner).mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not fetch when not owner', async () => {
    vi.mocked(checkIsOwner).mockReturnValue(false);
    const { result } = renderHook(() => useVixTrajectory(true));
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.hasData).toBe(false);
  });

  it('does not fetch when market is closed', async () => {
    renderHook(() => useVixTrajectory(false));
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches once on mount and updates state when owner + market open', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        snapshots: [
          { entryTime: '11:30 AM', vix: 17, vix1d: 13, vix9d: 16, spx: 6900 },
          { entryTime: '11:45 AM', vix: 17, vix1d: 14, vix9d: 16.5, spx: 6910 },
        ],
      }),
    });

    const { result } = renderHook(() => useVixTrajectory(true));

    await waitFor(() => expect(result.current.hasData).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/vix-snapshots-recent',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
    expect(result.current.spx).not.toBeNull();
    expect(result.current.spx!.delta).toBeCloseTo(10, 2);
  });

  it('polls at MARKET_DATA interval while open', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ snapshots: [] }),
    });

    renderHook(() => useVixTrajectory(true));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.MARKET_DATA);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('silently ignores non-ok responses (no state update)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    const { result } = renderHook(() => useVixTrajectory(true));

    await act(async () => {});
    // hasData stays false because we never setState on non-ok response.
    expect(result.current.hasData).toBe(false);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('swallows network errors without setting state', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useVixTrajectory(true));

    await act(async () => {});
    // No error field is exposed — just remains in EMPTY state.
    expect(result.current.hasData).toBe(false);
  });

  it('clears interval on unmount (no further fetches)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ snapshots: [] }),
    });

    const { unmount } = renderHook(() => useVixTrajectory(true));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    unmount();

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.MARKET_DATA * 3);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('handles response with no snapshots field (defaults to empty array)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const { result } = renderHook(() => useVixTrajectory(true));

    await waitFor(() => expect(result.current.hasData).toBe(true));
    expect(result.current.ratio1d).toBeNull();
    expect(result.current.spx).toBeNull();
  });

  it('does not setState after unmount when fetch resolves late', async () => {
    // Hold the fetch open.
    let resolveFetch: (v: unknown) => void = () => {};
    const pending = new Promise<unknown>((res) => {
      resolveFetch = res;
    });
    fetchMock.mockReturnValue(pending);

    const { result, unmount } = renderHook(() => useVixTrajectory(true));
    unmount();

    resolveFetch({
      ok: true,
      json: async () => ({
        snapshots: [
          { entryTime: '11:30 AM', vix: 17, vix1d: 13, vix9d: 16, spx: 6900 },
        ],
      }),
    });

    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    // State should still be the initial empty state (hasData=false).
    expect(result.current.hasData).toBe(false);
  });
});
