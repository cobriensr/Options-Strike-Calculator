import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// ── Mocks ─────────────────────────────────────────────────────

vi.mock('../../utils/auth', () => ({
  checkIsOwner: vi.fn(() => true),
}));

import { checkIsOwner } from '../../utils/auth';
import { useSpotGexHistory } from '../../hooks/useSpotGexHistory';

// ── Fixtures ──────────────────────────────────────────────────

const SAMPLE_RESPONSE = {
  date: '2026-04-20',
  timestamp: '2026-04-20T20:00:00.000Z',
  series: [
    { ts: '2026-04-20T14:00:00.000Z', netGex: 1_000_000_000, spot: 5800 },
    { ts: '2026-04-20T14:30:00.000Z', netGex: 1_200_000_000, spot: 5805 },
  ],
  availableDates: ['2026-04-20', '2026-04-17'],
};

const mockFetch = vi.fn();

// ── Lifecycle ────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-04-20T20:00:00.000Z'));
  mockFetch.mockReset().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => SAMPLE_RESPONSE,
  });
  vi.stubGlobal('fetch', mockFetch);
  vi.mocked(checkIsOwner).mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── Tests ────────────────────────────────────────────────────

describe('useSpotGexHistory: happy path', () => {
  it('fetches and returns the series on mount', async () => {
    const { result } = renderHook(() => useSpotGexHistory('2026-04-20', true));

    await waitFor(() => expect(result.current.series).toHaveLength(2));

    expect(result.current.series[0]?.spot).toBe(5800);
    expect(result.current.availableDates).toEqual(['2026-04-20', '2026-04-17']);
    expect(result.current.timestamp).toBe('2026-04-20T20:00:00.000Z');
    expect(result.current.error).toBeNull();
  });

  it('sends the date query parameter when provided', async () => {
    renderHook(() => useSpotGexHistory('2026-04-15', true));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/spot-gex-history?date=2026-04-15',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });

  it('omits the date query parameter when null', async () => {
    renderHook(() => useSpotGexHistory(null, true));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/spot-gex-history',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });
});

describe('useSpotGexHistory: 401 handling', () => {
  it('sets error and stops polling on 401', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Unauthorized' }),
    });

    const { result } = renderHook(() => useSpotGexHistory('2026-04-20', true));

    await waitFor(() => expect(result.current.error).not.toBeNull());

    expect(result.current.error?.message).toMatch(/unauthorized/i);
    const callsAfter401 = mockFetch.mock.calls.length;

    // Advance past several poll intervals — there should be no further
    // fetches once we've seen a 401.
    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });

    expect(mockFetch.mock.calls.length).toBe(callsAfter401);
  });
});

describe('useSpotGexHistory: date changes', () => {
  it('re-fetches when date changes', async () => {
    const { rerender } = renderHook(
      ({ date }: { date: string | null }) => useSpotGexHistory(date, true),
      { initialProps: { date: '2026-04-20' as string | null } },
    );

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    rerender({ date: '2026-04-17' });

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(mockFetch.mock.calls[1]?.[0]).toBe(
      '/api/spot-gex-history?date=2026-04-17',
    );
  });
});

describe('useSpotGexHistory: lifecycle', () => {
  it('aborts in-flight fetch on unmount', async () => {
    // Make fetch hang so we can catch the abort.
    const capturedSignals: AbortSignal[] = [];
    mockFetch.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) => {
        capturedSignals.push(init.signal);
        return new Promise(() => {
          // never resolves
        });
      },
    );

    const { unmount } = renderHook(() => useSpotGexHistory('2026-04-20', true));

    // Wait for fetch to start.
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    unmount();

    // After unmount, the controller.abort() call should have fired.
    expect(capturedSignals[0]?.aborted).toBe(true);
  });

  it('does not fetch when not the owner', async () => {
    vi.mocked(checkIsOwner).mockReturnValue(false);

    const { result } = renderHook(() => useSpotGexHistory('2026-04-20', true));

    await act(async () => {});

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });
});
