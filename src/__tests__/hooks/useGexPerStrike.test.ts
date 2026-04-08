import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useGexPerStrike } from '../../hooks/useGexPerStrike';
import type { GexStrikeLevel } from '../../hooks/useGexPerStrike';
import { POLL_INTERVALS } from '../../constants';

// ── Mocks ─────────────────────────────────────────────────

vi.mock('../../hooks/useIsOwner', () => ({
  useIsOwner: vi.fn(() => true),
}));

import { useIsOwner } from '../../hooks/useIsOwner';

const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ strikes: [], timestamp: null }),
});
vi.stubGlobal('fetch', mockFetch);

// ── Helpers ───────────────────────────────────────────────

function makeStrike(overrides: Partial<GexStrikeLevel> = {}): GexStrikeLevel {
  return {
    strike: 5800,
    price: 5795,
    callGammaOi: 500_000_000_000,
    putGammaOi: -300_000_000_000,
    netGamma: 200_000_000_000,
    callGammaVol: 100_000_000_000,
    putGammaVol: -50_000_000_000,
    netGammaVol: 50_000_000_000,
    volReinforcement: 'reinforcing' as const,
    callGammaAsk: -100_000_000,
    callGammaBid: 200_000_000,
    putGammaAsk: 50_000_000,
    putGammaBid: -150_000_000,
    callCharmOi: 1_000_000_000,
    putCharmOi: -800_000_000,
    netCharm: 200_000_000,
    callCharmVol: 500_000_000,
    putCharmVol: -400_000_000,
    netCharmVol: 100_000_000,
    callDeltaOi: 5_000_000_000,
    putDeltaOi: -3_000_000_000,
    netDelta: 2_000_000_000,
    callVannaOi: 100_000_000,
    putVannaOi: -60_000_000,
    netVanna: 40_000_000,
    callVannaVol: 50_000_000,
    putVannaVol: -30_000_000,
    netVannaVol: 20_000_000,
    ...overrides,
  };
}

// ── Lifecycle ─────────────────────────────────────────────

// Fixed wall-clock anchor for the suite. Most snapshot mocks use timestamps
// in the 19:58-20:00 UTC range, so anchoring `Date.now()` at 20:00:00 keeps
// them within the hook's 2-minute freshness threshold and makes `isLive`
// assertions deterministic. Tests that exercise staleness can advance the
// clock past this anchor.
const TEST_NOW = new Date('2026-04-02T20:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(TEST_NOW);
  mockFetch.mockReset().mockResolvedValue({
    ok: true,
    json: async () => ({ strikes: [], timestamp: null }),
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

describe('useGexPerStrike: initial state', () => {
  it('returns empty strikes initially', async () => {
    const { result } = renderHook(() => useGexPerStrike(true));

    await act(async () => {});

    expect(result.current.strikes).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('starts in loading state', () => {
    const { result } = renderHook(() => useGexPerStrike(true));
    expect(result.current.loading).toBe(true);
  });
});

// ============================================================
// FETCHING
// ============================================================

describe('useGexPerStrike: fetching', () => {
  it('fetches GEX data on mount when owner and market open', async () => {
    renderHook(() => useGexPerStrike(true));

    await act(async () => {});

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('/api/gex-per-strike', {
      credentials: 'same-origin',
      signal: expect.any(AbortSignal),
    });
  });

  it('returns strikes from API response', async () => {
    const strikes = [makeStrike(), makeStrike({ strike: 5805 })];
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        strikes,
        timestamp: '2026-04-02T15:00:00Z',
      }),
    });

    const { result } = renderHook(() => useGexPerStrike(true));

    await waitFor(() => expect(result.current.strikes).toHaveLength(2));

    expect(result.current.strikes[0]!.strike).toBe(5800);
    expect(result.current.error).toBeNull();
  });

  it('sets timestamp from API response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        strikes: [makeStrike()],
        timestamp: '2026-04-02T15:00:00Z',
      }),
    });

    const { result } = renderHook(() => useGexPerStrike(true));

    await waitFor(() =>
      expect(result.current.timestamp).toBe('2026-04-02T15:00:00Z'),
    );
  });
});

// ============================================================
// POLLING
// ============================================================

describe('useGexPerStrike: polling', () => {
  it('polls at POLL_INTERVALS.GEX_STRIKE interval', async () => {
    renderHook(() => useGexPerStrike(true));

    await act(async () => {});

    const initialCalls = mockFetch.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.GEX_STRIKE);
    });

    expect(mockFetch.mock.calls.length).toBeGreaterThan(initialCalls);
  });

  it('cleans up interval on unmount', async () => {
    const { unmount } = renderHook(() => useGexPerStrike(true));

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

describe('useGexPerStrike: gating', () => {
  it('does not fetch when not owner', async () => {
    vi.mocked(useIsOwner).mockReturnValue(false);

    renderHook(() => useGexPerStrike(true));

    await act(async () => {});

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetches once but does not poll when market is closed', async () => {
    // After-hours: still show today's latest snapshot (BACKTEST mode), but
    // no point polling — no fresh snapshots are being written.
    renderHook(() => useGexPerStrike(false));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    // Verify polling does NOT activate
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.GEX_STRIKE * 5);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('sets loading to false when not owner', async () => {
    vi.mocked(useIsOwner).mockReturnValue(false);

    const { result } = renderHook(() => useGexPerStrike(true));

    await act(async () => {});

    expect(result.current.loading).toBe(false);
  });

  it('sets loading to false when market closed', async () => {
    const { result } = renderHook(() => useGexPerStrike(false));

    await act(async () => {});

    expect(result.current.loading).toBe(false);
  });
});

// ============================================================
// ERROR HANDLING
// ============================================================

describe('useGexPerStrike: error handling', () => {
  it('sets error on non-ok response (not 401)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Internal error' }),
    });

    const { result } = renderHook(() => useGexPerStrike(true));

    await waitFor(() =>
      expect(result.current.error).toBe('Failed to load GEX data'),
    );
  });

  it('does not set error on 401 response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Not authenticated' }),
    });

    const { result } = renderHook(() => useGexPerStrike(true));

    await act(async () => {});

    expect(result.current.error).toBeNull();
  });

  it('sets error on network failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useGexPerStrike(true));

    await waitFor(() => expect(result.current.error).toBe('Network error'));
  });

  it('clears error on successful subsequent fetch', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'fail' }),
    });

    const { result } = renderHook(() => useGexPerStrike(true));

    await waitFor(() => expect(result.current.error).toBeTruthy());

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ strikes: [], timestamp: null }),
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

describe('useGexPerStrike: backtest mode', () => {
  it('fetches with date param when selectedDate provided', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        strikes: [makeStrike()],
        timestamp: '2026-03-28T15:00:00Z',
      }),
    });

    renderHook(() => useGexPerStrike(false, '2026-03-28'));

    await act(async () => {});

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain('?date=2026-03-28');
  });

  it('fetches once without polling in backtest mode', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ strikes: [], timestamp: null }),
    });

    renderHook(() => useGexPerStrike(false, '2026-03-28'));

    await act(async () => {});

    const initialCalls = mockFetch.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.GEX_STRIKE * 3);
    });

    expect(mockFetch.mock.calls.length).toBe(initialCalls);
  });

  it('returns strikes from backtest date', async () => {
    const strikes = [makeStrike({ strike: 5750 })];
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        strikes,
        timestamp: '2026-03-28T15:00:00Z',
      }),
    });

    const { result } = renderHook(() => useGexPerStrike(false, '2026-03-28'));

    await waitFor(() => expect(result.current.strikes).toHaveLength(1));

    expect(result.current.strikes[0]!.strike).toBe(5750);
    expect(result.current.loading).toBe(false);
  });

  it('does not fetch in backtest mode when not owner', async () => {
    vi.mocked(useIsOwner).mockReturnValue(false);

    renderHook(() => useGexPerStrike(false, '2026-03-28'));

    await act(async () => {});

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('passes time param when selectedTime provided', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        strikes: [makeStrike()],
        timestamp: '2026-03-28T15:30:00Z',
      }),
    });

    renderHook(() => useGexPerStrike(false, '2026-03-28', '10:30'));

    await act(async () => {});

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain('date=2026-03-28');
    expect(url).toContain('time=10%3A30');
  });
});

// ============================================================
// SCRUB CONTROLS
// ============================================================

function mockSnapshot(timestamp: string, timestamps: string[]) {
  return {
    ok: true,
    json: async () => ({
      strikes: [makeStrike()],
      timestamp,
      timestamps,
    }),
  };
}

describe('useGexPerStrike: scrub controls', () => {
  it('exposes timestamps from the API response', async () => {
    const ts = ['2026-04-02T19:58:00Z', '2026-04-02T19:59:00Z'];
    mockFetch.mockResolvedValue(mockSnapshot('2026-04-02T19:59:00Z', ts));

    const { result } = renderHook(() => useGexPerStrike(true));

    await waitFor(() => expect(result.current.timestamps).toEqual(ts));
    expect(result.current.isLive).toBe(true);
  });

  it('canScrubPrev is true when at least one earlier snapshot exists', async () => {
    mockFetch.mockResolvedValue(
      mockSnapshot('2026-04-02T19:59:00Z', [
        '2026-04-02T19:58:00Z',
        '2026-04-02T19:59:00Z',
      ]),
    );

    const { result } = renderHook(() => useGexPerStrike(true));

    await waitFor(() => expect(result.current.canScrubPrev).toBe(true));
    // canScrubNext is false on live with no scrub set
    expect(result.current.canScrubNext).toBe(false);
  });

  it('scrubPrev steps backwards and pauses polling', async () => {
    const ts = [
      '2026-04-02T19:57:00Z',
      '2026-04-02T19:58:00Z',
      '2026-04-02T19:59:00Z',
    ];
    mockFetch.mockResolvedValue(mockSnapshot('2026-04-02T19:59:00Z', ts));

    const { result } = renderHook(() => useGexPerStrike(true));
    await waitFor(() => expect(result.current.timestamps).toEqual(ts));

    const callsBeforeScrub = mockFetch.mock.calls.length;

    act(() => {
      result.current.scrubPrev();
    });

    // Scrub fetch fires immediately with the new ?ts param
    await waitFor(() =>
      expect(mockFetch.mock.calls.length).toBe(callsBeforeScrub + 1),
    );
    const scrubUrl = mockFetch.mock.calls[callsBeforeScrub]?.[0] as string;
    expect(scrubUrl).toContain('ts=2026-04-02T19%3A58%3A00Z');
    expect(result.current.isLive).toBe(false);

    // Polling should now be paused — interval ticks should not fire fetches
    const callsAfterScrub = mockFetch.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.GEX_STRIKE * 3);
    });
    expect(mockFetch.mock.calls.length).toBe(callsAfterScrub);
  });

  it('scrubNext from a scrubbed position resumes live at the end', async () => {
    const ts = ['2026-04-02T19:58:00Z', '2026-04-02T19:59:00Z'];
    mockFetch.mockResolvedValue(mockSnapshot('2026-04-02T19:59:00Z', ts));

    const { result } = renderHook(() => useGexPerStrike(true));
    await waitFor(() => expect(result.current.timestamps).toEqual(ts));

    // Scrub back one
    act(() => {
      result.current.scrubPrev();
    });
    await waitFor(() => expect(result.current.isLive).toBe(false));

    // Forward — should snap back to live
    act(() => {
      result.current.scrubNext();
    });
    await waitFor(() => expect(result.current.isLive).toBe(true));
  });

  it('scrubLive clears scrub and resumes polling', async () => {
    const ts = ['2026-04-02T19:58:00Z', '2026-04-02T19:59:00Z'];
    mockFetch.mockResolvedValue(mockSnapshot('2026-04-02T19:59:00Z', ts));

    const { result } = renderHook(() => useGexPerStrike(true));
    await waitFor(() => expect(result.current.timestamps).toEqual(ts));

    act(() => {
      result.current.scrubPrev();
    });
    await waitFor(() => expect(result.current.isLive).toBe(false));

    act(() => {
      result.current.scrubLive();
    });
    await waitFor(() => expect(result.current.isLive).toBe(true));

    // Polling resumes — next interval tick should fire a fetch
    const callsAfterResume = mockFetch.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.GEX_STRIKE);
    });
    expect(mockFetch.mock.calls.length).toBeGreaterThan(callsAfterResume);
  });

  it('scrubPrev is a no-op when no history exists', async () => {
    mockFetch.mockResolvedValue(mockSnapshot('2026-04-02T19:59:00Z', []));

    const { result } = renderHook(() => useGexPerStrike(true));
    await waitFor(() => expect(result.current.timestamps).toEqual([]));

    const callsBefore = mockFetch.mock.calls.length;
    act(() => {
      result.current.scrubPrev();
    });
    // No fetch should fire — still live, scrubTimestamp stays null
    await act(async () => {});
    expect(result.current.isLive).toBe(true);
    expect(mockFetch.mock.calls.length).toBe(callsBefore);
  });

  it('clears scrub state when selectedDate changes', async () => {
    const ts = ['2026-04-02T19:58:00Z', '2026-04-02T19:59:00Z'];
    mockFetch.mockResolvedValue(mockSnapshot('2026-04-02T19:59:00Z', ts));

    const { result, rerender } = renderHook(
      ({ date }: { date?: string }) => useGexPerStrike(true, date),
      { initialProps: { date: undefined as string | undefined } },
    );
    await waitFor(() => expect(result.current.timestamps).toEqual(ts));

    act(() => {
      result.current.scrubPrev();
    });
    await waitFor(() => expect(result.current.isScrubbed).toBe(true));

    // Switching to a different date must clear scrub state — the previous
    // date's snapshot list no longer applies. After the rerender we are no
    // longer scrubbed; isLive may still be false because '2026-04-01' is a
    // past date (backtest mode), but isScrubbed must be false.
    rerender({ date: '2026-04-01' });
    await waitFor(() => expect(result.current.isScrubbed).toBe(false));
  });
});

// ============================================================
// LIVE / BACKTEST / SCRUBBED STATE
// ============================================================

describe('useGexPerStrike: live vs backtest vs scrubbed', () => {
  it('isLive=true when market open, no scrub, today (no date passed)', async () => {
    const ts = ['2026-04-02T19:59:00Z'];
    mockFetch.mockResolvedValue(mockSnapshot('2026-04-02T19:59:00Z', ts));

    const { result } = renderHook(() => useGexPerStrike(true));

    await waitFor(() => expect(result.current.timestamps).toEqual(ts));
    expect(result.current.isLive).toBe(true);
    expect(result.current.isScrubbed).toBe(false);
  });

  it('isLive=false when market is closed (BACKTEST view of today)', async () => {
    const ts = ['2026-04-02T19:59:00Z'];
    mockFetch.mockResolvedValue(mockSnapshot('2026-04-02T19:59:00Z', ts));

    // Pass today's date so we hit the explicit-date branch but with today.
    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/New_York',
    });
    const { result } = renderHook(() => useGexPerStrike(false, today));

    await waitFor(() => expect(result.current.timestamps).toEqual(ts));
    // Market closed → not live, but also not scrubbed → BACKTEST.
    expect(result.current.isLive).toBe(false);
    expect(result.current.isScrubbed).toBe(false);
  });

  it('isLive=false when viewing a historical date (BACKTEST)', async () => {
    const ts = ['2026-04-02T19:59:00Z'];
    mockFetch.mockResolvedValue(mockSnapshot('2026-04-02T19:59:00Z', ts));

    // Past date — even with marketOpen=true, this is a backtest view.
    const { result } = renderHook(() => useGexPerStrike(true, '2020-01-02'));

    await waitFor(() => expect(result.current.timestamps).toEqual(ts));
    expect(result.current.isLive).toBe(false);
    expect(result.current.isScrubbed).toBe(false);
  });

  it('isScrubbed=true after stepping backwards', async () => {
    const ts = ['2026-04-02T19:58:00Z', '2026-04-02T19:59:00Z'];
    mockFetch.mockResolvedValue(mockSnapshot('2026-04-02T19:59:00Z', ts));

    const { result } = renderHook(() => useGexPerStrike(true));
    await waitFor(() => expect(result.current.timestamps).toEqual(ts));

    act(() => {
      result.current.scrubPrev();
    });

    await waitFor(() => expect(result.current.isScrubbed).toBe(true));
    expect(result.current.isLive).toBe(false);
  });
});

// ============================================================
// LIVE POLLING + WALL-CLOCK FRESHNESS
// ============================================================

describe('useGexPerStrike: live polling and freshness', () => {
  it('polls every POLL_INTERVAL when market open, today, not scrubbed', async () => {
    const ts = ['2026-04-02T19:59:30Z'];
    mockFetch.mockResolvedValue(mockSnapshot('2026-04-02T19:59:30Z', ts));

    renderHook(() => useGexPerStrike(true));

    // Initial fetch on mount
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    // One poll interval later → another fetch
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.GEX_STRIKE);
    });
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    // And another
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.GEX_STRIKE);
    });
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
  });

  it('polls today even when an explicit (today) date is passed', async () => {
    // Production always passes vix.selectedDate, so this is the realistic
    // production code path. Verifies the polling branch isn't gated on the
    // old `hasExplicitDate` short-circuit.
    const ts = ['2026-04-02T19:59:30Z'];
    mockFetch.mockResolvedValue(mockSnapshot('2026-04-02T19:59:30Z', ts));

    renderHook(() => useGexPerStrike(true, '2026-04-02'));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.GEX_STRIKE);
    });
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  });

  it('does not poll on a past date (backtest mode)', async () => {
    mockFetch.mockResolvedValue(
      mockSnapshot('2020-01-02T15:00:00Z', ['2020-01-02T15:00:00Z']),
    );

    renderHook(() => useGexPerStrike(true, '2020-01-02'));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.GEX_STRIKE * 5);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not poll while scrubbed', async () => {
    const ts = ['2026-04-02T19:58:00Z', '2026-04-02T19:59:00Z'];
    mockFetch.mockResolvedValue(mockSnapshot('2026-04-02T19:59:00Z', ts));

    const { result } = renderHook(() => useGexPerStrike(true));
    await waitFor(() => expect(result.current.timestamps).toEqual(ts));

    act(() => {
      result.current.scrubPrev();
    });
    await waitFor(() => expect(result.current.isScrubbed).toBe(true));

    const callsAfterScrub = mockFetch.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.GEX_STRIKE * 5);
    });
    expect(mockFetch.mock.calls.length).toBe(callsAfterScrub);
  });

  it('isLive=true when displayed snapshot is within freshness threshold', async () => {
    // Snapshot is 30s old at TEST_NOW (20:00:00) — within 2-min threshold.
    mockFetch.mockResolvedValue(
      mockSnapshot('2026-04-02T19:59:30Z', ['2026-04-02T19:59:30Z']),
    );

    const { result } = renderHook(() => useGexPerStrike(true));
    await waitFor(() => expect(result.current.isLive).toBe(true));
  });

  it('isLive=false when displayed snapshot is older than freshness threshold', async () => {
    // Snapshot is 5 minutes old at TEST_NOW (20:00:00) — beyond 2-min threshold.
    // This is the dial-back case: user picked a past time, panel shows that
    // snapshot, polling keeps refetching the same one, but the badge correctly
    // shows BACKTEST because the data isn't actually live.
    mockFetch.mockResolvedValue(
      mockSnapshot('2026-04-02T19:55:00Z', ['2026-04-02T19:55:00Z']),
    );

    const { result } = renderHook(() => useGexPerStrike(true));
    await waitFor(() => expect(result.current.timestamps.length).toBe(1));

    expect(result.current.isLive).toBe(false);
    expect(result.current.isScrubbed).toBe(false);
  });

  it('isLive flips from true to false as the wall clock advances past staleness', async () => {
    // Start fresh: snapshot is 30s old at TEST_NOW.
    mockFetch.mockResolvedValue(
      mockSnapshot('2026-04-02T19:59:30Z', ['2026-04-02T19:59:30Z']),
    );

    const { result } = renderHook(() => useGexPerStrike(true));
    await waitFor(() => expect(result.current.isLive).toBe(true));

    // Advance 3 minutes. Polling fires (refetches the same stale snapshot)
    // and the wall-clock ticker fires (re-snapping `nowMs`). The freshness
    // check should now flip to false because (now - timestamp) > 2 min.
    await act(async () => {
      vi.advanceTimersByTime(3 * 60 * 1000);
    });

    await waitFor(() => expect(result.current.isLive).toBe(false));
    expect(result.current.isScrubbed).toBe(false);
  });
});
