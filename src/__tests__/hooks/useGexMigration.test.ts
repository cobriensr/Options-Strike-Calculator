import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useGexMigration } from '../../hooks/useGexMigration';
import type { GexSnapshot } from '../../utils/gex-migration';
import { POLL_INTERVALS } from '../../constants';

// ── Mocks ─────────────────────────────────────────────────

vi.mock('../../hooks/useIsOwner', () => ({
  useIsOwner: vi.fn(() => true),
}));

import { useIsOwner } from '../../hooks/useIsOwner';

const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ snapshots: [], date: '2026-04-07' }),
});
vi.stubGlobal('fetch', mockFetch);

// ── Helpers ───────────────────────────────────────────────

function makeSnapshot(timestamp: string, price = 6615): GexSnapshot {
  return {
    timestamp,
    price,
    strikes: [
      {
        strike: 6620,
        price,
        callGammaOi: 100,
        putGammaOi: -50,
        callGammaVol: 30,
        putGammaVol: -20,
        callGammaAsk: 10,
        callGammaBid: 15,
        putGammaAsk: -5,
        putGammaBid: -10,
      },
    ],
  };
}

// ── Lifecycle ─────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mockFetch.mockReset().mockResolvedValue({
    ok: true,
    json: async () => ({ snapshots: [], date: '2026-04-07' }),
  });
  vi.mocked(useIsOwner).mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();

  vi.stubGlobal('fetch', mockFetch);
});

// ============================================================
// INITIAL STATE
// ============================================================

describe('useGexMigration: initial state', () => {
  it('returns empty snapshots initially', async () => {
    const { result } = renderHook(() => useGexMigration(true));
    await act(async () => {});
    expect(result.current.snapshots).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('starts in loading state', () => {
    const { result } = renderHook(() => useGexMigration(true));
    expect(result.current.loading).toBe(true);
  });
});

// ============================================================
// FETCHING
// ============================================================

describe('useGexMigration: fetching', () => {
  it('fetches migration data on mount when owner and market open', async () => {
    renderHook(() => useGexMigration(true));
    await act(async () => {});
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('/api/gex-migration-0dte', {
      credentials: 'same-origin',
      signal: expect.any(AbortSignal),
    });
  });

  it('returns snapshots from API response', async () => {
    const snapshots = [
      makeSnapshot('2026-04-07T20:00:00Z'),
      makeSnapshot('2026-04-07T20:01:00Z'),
    ];
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ snapshots, date: '2026-04-07' }),
    });

    const { result } = renderHook(() => useGexMigration(true));
    await waitFor(() => expect(result.current.snapshots).toHaveLength(2));
    expect(result.current.snapshots[0]!.timestamp).toBe('2026-04-07T20:00:00Z');
    expect(result.current.error).toBeNull();
  });
});

// ============================================================
// POLLING
// ============================================================

describe('useGexMigration: polling', () => {
  it('polls at POLL_INTERVALS.GEX_STRIKE interval', async () => {
    renderHook(() => useGexMigration(true));
    await act(async () => {});
    const initialCalls = mockFetch.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.GEX_STRIKE);
    });
    expect(mockFetch.mock.calls.length).toBeGreaterThan(initialCalls);
  });

  it('polls today even when an explicit (today) date is passed', async () => {
    // Production always passes vix.selectedDate, so this is the realistic
    // production code path. Regression guard against the old
    // `hasExplicitDate` short-circuit that made polling unreachable.
    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/New_York',
    });

    renderHook(() => useGexMigration(true, today));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.GEX_STRIKE);
    });
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  });

  it('cleans up interval on unmount', async () => {
    const { unmount } = renderHook(() => useGexMigration(true));
    await act(async () => {});

    const callsAfterMount = mockFetch.mock.calls.length;
    unmount();

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.GEX_STRIKE * 3);
    });
    expect(mockFetch.mock.calls.length).toBe(callsAfterMount);
  });
});

// ============================================================
// GATING
// ============================================================

describe('useGexMigration: gating', () => {
  it('does not fetch when not owner', async () => {
    vi.mocked(useIsOwner).mockReturnValue(false);
    renderHook(() => useGexMigration(true));
    await act(async () => {});
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetches once but does not poll when market is closed', async () => {
    // After-hours BACKTEST view of today — still show the day's migration
    // data, but no point polling when no fresh snapshots are being written.
    renderHook(() => useGexMigration(false));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.GEX_STRIKE * 5);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('sets loading to false when not owner', async () => {
    vi.mocked(useIsOwner).mockReturnValue(false);
    const { result } = renderHook(() => useGexMigration(true));
    await act(async () => {});
    expect(result.current.loading).toBe(false);
  });

  it('sets loading to false when market closed', async () => {
    const { result } = renderHook(() => useGexMigration(false));
    await act(async () => {});
    expect(result.current.loading).toBe(false);
  });
});

// ============================================================
// ERROR HANDLING
// ============================================================

describe('useGexMigration: error handling', () => {
  it('sets error on non-ok response (not 401)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Internal error' }),
    });

    const { result } = renderHook(() => useGexMigration(true));
    await waitFor(() =>
      expect(result.current.error).toBe('Failed to load GEX migration data'),
    );
  });

  it('does not set error on 401 response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Not authenticated' }),
    });

    const { result } = renderHook(() => useGexMigration(true));
    await act(async () => {});
    expect(result.current.error).toBeNull();
  });

  it('sets error on network failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    const { result } = renderHook(() => useGexMigration(true));
    await waitFor(() => expect(result.current.error).toBe('Network error'));
  });

  it('clears error on successful subsequent fetch', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'fail' }),
    });

    const { result } = renderHook(() => useGexMigration(true));
    await waitFor(() => expect(result.current.error).toBeTruthy());

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ snapshots: [], date: '2026-04-07' }),
    });

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.GEX_STRIKE);
    });

    await waitFor(() => expect(result.current.error).toBeNull());
  });
});

// ============================================================
// BACKTEST MODE (selectedDate)
// ============================================================

describe('useGexMigration: backtest mode', () => {
  it('fetches with date param when selectedDate provided', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ snapshots: [], date: '2026-03-28' }),
    });

    renderHook(() => useGexMigration(false, '2026-03-28'));
    await act(async () => {});

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain('?date=2026-03-28');
  });

  it('fetches once without polling in backtest mode', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ snapshots: [], date: '2026-03-28' }),
    });

    renderHook(() => useGexMigration(false, '2026-03-28'));
    await act(async () => {});

    const initialCalls = mockFetch.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.GEX_STRIKE * 3);
    });
    expect(mockFetch.mock.calls.length).toBe(initialCalls);
  });

  it('does not fetch in backtest mode when not owner', async () => {
    vi.mocked(useIsOwner).mockReturnValue(false);
    renderHook(() => useGexMigration(false, '2026-03-28'));
    await act(async () => {});
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
