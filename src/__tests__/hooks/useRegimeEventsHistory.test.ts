/**
 * useRegimeEventsHistory tests — mirrors the useSpotGexHistory shape:
 * happy path, 401 handling, unmount cleanup, owner gating.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('../../hooks/useIsOwner', () => ({
  useIsOwner: vi.fn(() => true),
}));

import { useIsOwner } from '../../hooks/useIsOwner';
import { useRegimeEventsHistory } from '../../hooks/useRegimeEventsHistory';

// ── Fixtures ──────────────────────────────────────────────────

const SAMPLE_RESPONSE = {
  events: [
    {
      id: 2,
      ts: '2026-04-20T20:00:00.000Z',
      type: 'REGIME_FLIP',
      severity: 'urgent',
      title: 'Regime flip: POSITIVE → NEGATIVE',
      body: 'Net GEX flipped negative — dealers amplify moves.',
      delivered_count: 2,
    },
    {
      id: 1,
      ts: '2026-04-20T19:45:00.000Z',
      type: 'LEVEL_BREACH',
      severity: 'urgent',
      title: 'call wall broken at 5830.00',
      body: 'ES 5832.00 has broken through the call wall (5830.00).',
      delivered_count: 2,
    },
  ],
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
  vi.mocked(useIsOwner).mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── Tests ────────────────────────────────────────────────────

describe('useRegimeEventsHistory: happy path', () => {
  it('fetches and returns events on mount', async () => {
    const { result } = renderHook(() => useRegimeEventsHistory(true));

    await waitFor(() => expect(result.current.events).toHaveLength(2));

    expect(result.current.events[0]).toMatchObject({
      id: 2,
      type: 'REGIME_FLIP',
      severity: 'urgent',
      deliveredCount: 2,
    });
    expect(result.current.error).toBeNull();
  });

  it('sends the limit query parameter', async () => {
    renderHook(() => useRegimeEventsHistory(true));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const firstUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(firstUrl).toBe('/api/push/recent-events?limit=20');
  });
});

describe('useRegimeEventsHistory: 401 handling', () => {
  it('sets error and stops polling on 401', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Unauthorized' }),
    });

    const { result } = renderHook(() => useRegimeEventsHistory(true));
    await waitFor(() => expect(result.current.error).not.toBeNull());

    expect(result.current.error?.message).toMatch(/unauthorized/i);
    const callsAfter401 = mockFetch.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(10 * 60_000);
    });

    expect(mockFetch.mock.calls.length).toBe(callsAfter401);
  });
});

describe('useRegimeEventsHistory: lifecycle', () => {
  it('aborts in-flight fetch on unmount', async () => {
    const capturedSignals: AbortSignal[] = [];
    mockFetch.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) => {
        capturedSignals.push(init.signal);
        return new Promise(() => {
          // never resolves
        });
      },
    );

    const { unmount } = renderHook(() => useRegimeEventsHistory(true));
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    unmount();
    expect(capturedSignals[0]?.aborted).toBe(true);
  });

  it('does not fetch when not the owner', async () => {
    vi.mocked(useIsOwner).mockReturnValue(false);

    const { result } = renderHook(() => useRegimeEventsHistory(true));
    await act(async () => {});

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });

  it('refresh() re-fires the fetch', async () => {
    const { result } = renderHook(() => useRegimeEventsHistory(true));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    await act(async () => {
      result.current.refresh();
    });

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  });
});
