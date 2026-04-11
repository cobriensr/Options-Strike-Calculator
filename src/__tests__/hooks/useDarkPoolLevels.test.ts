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

  it('starts live with no scrub time', () => {
    const { result } = renderHook(() => useDarkPoolLevels(true));
    expect(result.current.scrubTime).toBeNull();
    expect(result.current.isLive).toBe(true);
    expect(result.current.isScrubbed).toBe(false);
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
    // Live mode: always sends ?date= but never ?time=
    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain('date=');
    expect(url).not.toContain('time=');
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

    const { result } = renderHook(() => useDarkPoolLevels(true));

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

  it('does not poll when scrub time is set (scrubbed snapshots are static)', async () => {
    const { result } = renderHook(() => useDarkPoolLevels(true));
    await act(async () => {});

    // Enter scrub mode
    act(() => {
      result.current.scrubPrev();
    });
    await act(async () => {});

    const callsAfterScrub = mockFetch.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.DARK_POOL * 3);
    });

    expect(mockFetch.mock.calls.length).toBe(callsAfterScrub);
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
  it('fetches with date param when selectedDate is changed', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ levels: [makeLevel()], date: '2026-03-28' }),
    });

    const { result } = renderHook(() => useDarkPoolLevels(false));
    await act(async () => {});

    act(() => {
      result.current.setSelectedDate('2026-03-28');
    });
    await act(async () => {});

    const calls = mockFetch.mock.calls;
    const lastCall = calls.at(-1)?.[0] as string;
    expect(lastCall).toContain('date=2026-03-28');
  });

  it('fetches once without polling after date changes to past', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ levels: [], date: '2026-03-28' }),
    });

    const { result } = renderHook(() => useDarkPoolLevels(false));
    await act(async () => {});

    act(() => {
      result.current.setSelectedDate('2026-03-28');
    });
    await act(async () => {});

    const callsAfterDateChange = mockFetch.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.DARK_POOL * 3);
    });

    expect(mockFetch.mock.calls.length).toBe(callsAfterDateChange);
  });

  it('does not fetch in backtest mode when not owner', async () => {
    vi.mocked(useIsOwner).mockReturnValue(false);

    const { result } = renderHook(() => useDarkPoolLevels(false));
    await act(async () => {});

    act(() => {
      result.current.setSelectedDate('2026-03-28');
    });
    await act(async () => {});

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ============================================================
// TIME SCRUBBING
// ============================================================

describe('useDarkPoolLevels: time scrubbing', () => {
  it('does not include time= param in live mode', async () => {
    // REGRESSION GUARD: the hook must never send ?time= when the user has not
    // explicitly scrubbed. Coupling to the app's time picker caused the
    // "panel appears frozen while polling" bug — polling refetched the same
    // stale snapshot every cycle while updatedAt never advanced.
    renderHook(() => useDarkPoolLevels(true));
    await act(async () => {});

    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).not.toContain('time=');
  });

  it('includes time= param after scrubPrev', async () => {
    const { result } = renderHook(() => useDarkPoolLevels(true));
    await act(async () => {});

    act(() => {
      result.current.scrubPrev();
    });
    await act(async () => {});

    const lastUrl = mockFetch.mock.calls.at(-1)?.[0] as string;
    expect(lastUrl).toContain('time=');
    expect(result.current.isScrubbed).toBe(true);
    expect(result.current.isLive).toBe(false);
  });

  it('removes time= param after scrubLive', async () => {
    const { result } = renderHook(() => useDarkPoolLevels(true));
    await act(async () => {});

    // Enter scrub mode
    act(() => {
      result.current.scrubPrev();
    });
    await act(async () => {});

    // Return to live
    act(() => {
      result.current.scrubLive();
    });
    await act(async () => {});

    expect(result.current.isLive).toBe(true);
    expect(result.current.scrubTime).toBeNull();
  });

  it('canScrubPrev is true in live mode (entering scrub)', () => {
    const { result } = renderHook(() => useDarkPoolLevels(true));
    expect(result.current.canScrubPrev).toBe(true);
  });

  it('canScrubNext is false in live mode', () => {
    const { result } = renderHook(() => useDarkPoolLevels(true));
    expect(result.current.canScrubNext).toBe(false);
  });

  it('resets scrubTime when selectedDate changes', async () => {
    const { result } = renderHook(() => useDarkPoolLevels(true));
    await act(async () => {});

    // Enter scrub mode
    act(() => {
      result.current.scrubPrev();
    });
    await act(async () => {});
    expect(result.current.scrubTime).not.toBeNull();

    // Change date → scrub time should reset
    act(() => {
      result.current.setSelectedDate('2026-03-28');
    });
    await act(async () => {});
    expect(result.current.scrubTime).toBeNull();
  });
});
