/**
 * Hook tests for `useGammaWeeklyStats` — Phase 3b rolling-stats poll.
 *
 * Covers: public-session skip, window-size in URL, eager mount fetch,
 * error surface, refresh on window change, and the lazy 5-minute poll.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

import type { AggregateStats } from '../../hooks/useGammaWeeklyStats';

// ── Mocks ───────────────────────────────────────────────────────

vi.mock('../../utils/auth', () => ({
  getAccessMode: vi.fn(() => 'owner' as const),
}));

import { useGammaWeeklyStats } from '../../hooks/useGammaWeeklyStats';
import { getAccessMode } from '../../utils/auth';

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function makeStats(overrides: Partial<AggregateStats> = {}): AggregateStats {
  return {
    from: '2026-04-21',
    to: '2026-05-21',
    n_total: 12,
    n_with_outcome: 9,
    n_winners: 6,
    win_rate: 6 / 9,
    mean_edge_pts: 4.2,
    by_signal: [
      {
        signal_type: 'e1_long_call',
        n_total: 5,
        n_with_outcome: 4,
        n_winners: 3,
        win_rate: 3 / 4,
        mean_edge_pts: 3.5,
        expected_edge_pts: 5.36,
        edge_ratio: 3.5 / 5.36,
      },
      {
        signal_type: 'e5_long_put',
        n_total: 4,
        n_with_outcome: 3,
        n_winners: 2,
        win_rate: 2 / 3,
        mean_edge_pts: 5.0,
        expected_edge_pts: 8.95,
        edge_ratio: 5.0 / 8.95,
      },
      {
        signal_type: 'pcs_monday',
        n_total: 3,
        n_with_outcome: 2,
        n_winners: 1,
        win_rate: 0.5,
        mean_edge_pts: 8.0,
        expected_edge_pts: 16.27,
        edge_ratio: 8.0 / 16.27,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  vi.mocked(getAccessMode).mockReturnValue('owner');
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Tests ───────────────────────────────────────────────────────

describe('useGammaWeeklyStats', () => {
  it('skips fetch entirely for public visitors', async () => {
    vi.mocked(getAccessMode).mockReturnValue('public');
    const { result } = renderHook(() => useGammaWeeklyStats(30, true));
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('fetches with the default 30-day window on mount', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeStats()));
    const { result } = renderHook(() => useGammaWeeklyStats());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      '/api/gamma-setups/weekly-stats?days=30',
    );
    expect(result.current.data?.n_total).toBe(12);
    expect(result.current.error).toBeNull();
  });

  it('passes the requested window as the ?days= query param', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeStats()));
    renderHook(() => useGammaWeeklyStats(7, true));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]![0]).toBe(
      '/api/gamma-setups/weekly-stats?days=7',
    );
  });

  it('re-fetches when the window prop changes', async () => {
    fetchMock.mockResolvedValue(jsonResponse(makeStats()));
    const { result, rerender } = renderHook(
      ({ days }) => useGammaWeeklyStats(days as 7 | 14 | 30 | 60 | 90, true),
      { initialProps: { days: 30 } },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toContain('days=30');

    rerender({ days: 90 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]![0]).toContain('days=90');
    expect(result.current.error).toBeNull();
  });

  it('exposes error on non-2xx without overwriting prior data', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(makeStats()))
      .mockResolvedValueOnce(jsonResponse({ error: 'pg' }, 503));

    const { result } = renderHook(() => useGammaWeeklyStats(30, true));
    await waitFor(() => expect(result.current.data?.n_total).toBe(12));

    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() => expect(result.current.error).toContain('503'));
    // Prior data is preserved on refresh failure (UX: rolling bar doesn't
    // blank out when a single poll glitches).
    expect(result.current.data?.n_total).toBe(12);
  });

  it('captures fetch reject as an error message', async () => {
    fetchMock.mockRejectedValueOnce(new Error('AbortError'));
    const { result } = renderHook(() => useGammaWeeklyStats(30, true));
    await waitFor(() => expect(result.current.error).toBe('AbortError'));
  });

  it('polls at the 5-minute cadence while marketOpen=true', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(makeStats()));
    renderHook(() => useGammaWeeklyStats(30, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT poll when marketOpen=false (eager mount-fetch still runs)', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(makeStats()));
    renderHook(() => useGammaWeeklyStats(30, false));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 * 3);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('clears a prior error after a successful refresh', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'pg' }, 500))
      .mockResolvedValueOnce(jsonResponse(makeStats({ n_total: 99 })));

    const { result } = renderHook(() => useGammaWeeklyStats(30, false));
    await waitFor(() => expect(result.current.error).toContain('500'));

    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.data?.n_total).toBe(99);
  });
});
