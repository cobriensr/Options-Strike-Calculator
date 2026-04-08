import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useDarkPoolLevels } from '../../hooks/useDarkPoolLevels';
import type { DarkPoolLevel } from '../../hooks/useDarkPoolLevels';
import { POLL_INTERVALS } from '../../constants';

// ── Mocks ─────────────────────────────────────────────────

vi.mock('../../hooks/useIsOwner', () => ({
  useIsOwner: vi.fn(() => true),
}));

import { useIsOwner } from '../../hooks/useIsOwner';

const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ levels: [], date: '2026-04-02' }),
});
vi.stubGlobal('fetch', mockFetch);

// ── Helpers ───────────────────────────────────────────────

function makeLevel(overrides: Partial<DarkPoolLevel> = {}): DarkPoolLevel {
  return {
    spxLevel: 6575,
    totalPremium: 1_300_000_000,
    tradeCount: 13,
    totalShares: 2_000_000,
    latestTime: '2026-04-02T16:30:00Z',
    updatedAt: '2026-04-02T16:35:00Z',
    ...overrides,
  };
}

// ── Lifecycle ─────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mockFetch.mockReset().mockResolvedValue({
    ok: true,
    json: async () => ({ levels: [], date: '2026-04-02' }),
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

describe('useDarkPoolLevels: initial state', () => {
  it('returns empty levels initially', async () => {
    const { result } = renderHook(() => useDarkPoolLevels(true));

    await act(async () => {});

    expect(result.current.levels).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('starts in loading state', () => {
    const { result } = renderHook(() => useDarkPoolLevels(true));
    expect(result.current.loading).toBe(true);
  });
});

// ============================================================
// FETCHING
// ============================================================

describe('useDarkPoolLevels: fetching', () => {
  it('fetches dark pool levels on mount when owner and market open', async () => {
    renderHook(() => useDarkPoolLevels(true));

    await act(async () => {});

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('/api/darkpool-levels', {
      credentials: 'same-origin',
      signal: expect.any(AbortSignal),
    });
  });

  it('returns levels from API response', async () => {
    const levels = [makeLevel(), makeLevel({ spxLevel: 6600 })];
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ levels, date: '2026-04-02' }),
    });

    const { result } = renderHook(() => useDarkPoolLevels(true));

    await waitFor(() => expect(result.current.levels).toHaveLength(2));

    expect(result.current.levels[0]!.spxLevel).toBe(6575);
    expect(result.current.error).toBeNull();
  });

  it('sets updatedAt from first level (legacy fallback)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        levels: [makeLevel({ updatedAt: '2026-04-02T17:00:00Z' })],
        date: '2026-04-02',
      }),
    });

    const { result } = renderHook(() => useDarkPoolLevels(true));

    await waitFor(() =>
      expect(result.current.updatedAt).toBe('2026-04-02T17:00:00Z'),
    );
  });

  // REGRESSION GUARD: the displayed updatedAt badge used to be derived
  // from levels[0].updatedAt (the highest-premium row's timestamp). On
  // days where the top row is a big anchor level that gets its only
  // prints early and never receives more, that timestamp freezes while
  // the cron is still happily writing lower-ranked levels every minute.
  // The server now returns meta.lastUpdated = MAX(updated_at) across all
  // rows, which reflects the cron's actual last successful write. The
  // hook must prefer meta.lastUpdated when present.
  it('prefers meta.lastUpdated over levels[0].updatedAt when both are present', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        // Top row has a STALE updatedAt (hours behind) — simulating a
        // frozen anchor level.
        levels: [makeLevel({ updatedAt: '2026-04-02T13:30:00Z' })],
        date: '2026-04-02',
        // The cron's actual last successful write is much more recent.
        meta: { lastUpdated: '2026-04-02T19:58:00Z' },
      }),
    });

    const { result } = renderHook(() => useDarkPoolLevels(true));

    await waitFor(() =>
      expect(result.current.updatedAt).toBe('2026-04-02T19:58:00Z'),
    );
  });
});

// ============================================================
// POLLING
// ============================================================

describe('useDarkPoolLevels: polling', () => {
  it('polls at POLL_INTERVALS.DARK_POOL interval', async () => {
    renderHook(() => useDarkPoolLevels(true));

    await act(async () => {});

    const initialCalls = mockFetch.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.DARK_POOL);
    });

    expect(mockFetch.mock.calls.length).toBeGreaterThan(initialCalls);
  });

  it('cleans up interval on unmount', async () => {
    const { unmount } = renderHook(() => useDarkPoolLevels(true));

    await act(async () => {});

    const callsAfterMount = mockFetch.mock.calls.length;
    unmount();

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.DARK_POOL * 3);
    });

    expect(mockFetch.mock.calls.length).toBe(callsAfterMount);
  });

  it('advances the displayed updatedAt when polling fetches fresh data', async () => {
    // REGRESSION GUARD: the previous bug was that the hook coupled to
    // `selectedTime`, so every poll refetched the same stale snapshot. Fetch
    // counts still incremented, but the displayed `updatedAt` never changed,
    // so the panel looked frozen to the user. This test asserts that the
    // user-facing state actually advances — not just that polling fires.
    //
    // Use today's date (computed at runtime) so the `isToday` branch in the
    // dispatch ladder activates polling. A hardcoded past date would fall
    // into the one-shot BACKTEST branch and never poll.
    const todayET = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/New_York',
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        levels: [makeLevel({ updatedAt: `${todayET}T19:58:00Z` })],
        date: todayET,
      }),
    });

    const { result } = renderHook(() => useDarkPoolLevels(true, todayET));

    await waitFor(() =>
      expect(result.current.updatedAt).toBe(`${todayET}T19:58:00Z`),
    );

    // Next poll: the cron has written a newer block. The displayed
    // updatedAt must advance.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        levels: [makeLevel({ updatedAt: `${todayET}T19:59:00Z` })],
        date: todayET,
      }),
    });

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.DARK_POOL);
    });

    await waitFor(() =>
      expect(result.current.updatedAt).toBe(`${todayET}T19:59:00Z`),
    );
  });
});

// ============================================================
// GATING
// ============================================================

describe('useDarkPoolLevels: gating', () => {
  it('does not fetch when not owner', async () => {
    vi.mocked(useIsOwner).mockReturnValue(false);

    renderHook(() => useDarkPoolLevels(true));

    await act(async () => {});

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetches once but does not poll when market is closed', async () => {
    // After-hours BACKTEST view of today — still show the day's data, but
    // no point polling when no fresh blocks are being written.
    renderHook(() => useDarkPoolLevels(false));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.DARK_POOL * 5);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('sets loading to false when not owner', async () => {
    vi.mocked(useIsOwner).mockReturnValue(false);

    const { result } = renderHook(() => useDarkPoolLevels(true));

    await act(async () => {});

    expect(result.current.loading).toBe(false);
  });

  it('sets loading to false when market closed', async () => {
    const { result } = renderHook(() => useDarkPoolLevels(false));

    await act(async () => {});

    expect(result.current.loading).toBe(false);
  });
});

// ============================================================
// ERROR HANDLING
// ============================================================

describe('useDarkPoolLevels: error handling', () => {
  it('sets error on non-ok response (not 401)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Internal error' }),
    });

    const { result } = renderHook(() => useDarkPoolLevels(true));

    await waitFor(() =>
      expect(result.current.error).toBe('Failed to load dark pool data'),
    );
  });

  it('does not set error on 401 response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Not authenticated' }),
    });

    const { result } = renderHook(() => useDarkPoolLevels(true));

    await act(async () => {});

    expect(result.current.error).toBeNull();
  });

  it('sets error on network failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useDarkPoolLevels(true));

    await waitFor(() => expect(result.current.error).toBe('Network error'));
  });

  it('clears error on successful subsequent fetch', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'fail' }),
    });

    const { result } = renderHook(() => useDarkPoolLevels(true));

    await waitFor(() => expect(result.current.error).toBeTruthy());

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ levels: [], date: '2026-04-02' }),
    });

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.DARK_POOL);
    });

    await waitFor(() => expect(result.current.error).toBeNull());
  });
});

// ============================================================
// BACKTEST MODE (selectedDate)
// ============================================================

describe('useDarkPoolLevels: backtest mode', () => {
  it('fetches with date param when selectedDate provided', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ levels: [makeLevel()], date: '2026-03-28' }),
    });

    renderHook(() => useDarkPoolLevels(false, '2026-03-28'));

    await act(async () => {});

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain('?date=2026-03-28');
  });

  it('fetches once without polling in backtest mode', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ levels: [], date: '2026-03-28' }),
    });

    renderHook(() => useDarkPoolLevels(false, '2026-03-28'));

    await act(async () => {});

    const initialCalls = mockFetch.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.DARK_POOL * 3);
    });

    expect(mockFetch.mock.calls.length).toBe(initialCalls);
  });

  it('returns levels from backtest date', async () => {
    const levels = [makeLevel({ spxLevel: 6550 })];
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ levels, date: '2026-03-28' }),
    });

    const { result } = renderHook(() => useDarkPoolLevels(false, '2026-03-28'));

    await waitFor(() => expect(result.current.levels).toHaveLength(1));

    expect(result.current.levels[0]!.spxLevel).toBe(6550);
    expect(result.current.loading).toBe(false);
  });

  it('does not fetch in backtest mode when not owner', async () => {
    vi.mocked(useIsOwner).mockReturnValue(false);

    renderHook(() => useDarkPoolLevels(false, '2026-03-28'));

    await act(async () => {});

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not include a time param — the hook ignores selectedTime entirely', async () => {
    // Regression guard for the "panel appears frozen while polling" bug.
    // See useGexPerStrike.test.ts for the full explanation.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ levels: [makeLevel()], date: '2026-03-28' }),
    });

    renderHook(() => useDarkPoolLevels(false, '2026-03-28'));

    await act(async () => {});

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain('date=2026-03-28');
    expect(url).not.toContain('time=');
  });
});
