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
    callDeltaOi: 5_000_000_000,
    putDeltaOi: -3_000_000_000,
    netDelta: 2_000_000_000,
    callVannaOi: 100_000_000,
    putVannaOi: -60_000_000,
    netVanna: 40_000_000,
    ...overrides,
  };
}

// ── Lifecycle ─────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
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

  it('does not fetch when market is closed', async () => {
    renderHook(() => useGexPerStrike(false));

    await act(async () => {});

    expect(mockFetch).not.toHaveBeenCalled();
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
});
