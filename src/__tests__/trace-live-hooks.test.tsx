/**
 * Combined tests for the three TRACE Live foundation hooks:
 *   - useTraceLiveCountdown (pure derivation)
 *   - useTraceLiveChime    (effect, debounced)
 *   - useTraceLiveData     (fetch + polling)
 *
 * Bundled because they're all small and conceptually share the
 * "live-mode plumbing" surface — splitting into 3 files would just
 * triplicate the boilerplate.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { useTraceLiveCountdown } from '../components/TRACELive/hooks/useTraceLiveCountdown';
import { useTraceLiveChime } from '../components/TRACELive/hooks/useTraceLiveChime';
import { useTraceLiveData } from '../components/TRACELive/hooks/useTraceLiveData';
import * as chimeAudio from '../components/TRACELive/hooks/chime-audio';

// Mock useIsOwner globally for the data hook tests.
vi.mock('../hooks/useIsOwner', () => ({
  useIsOwner: vi.fn(() => true),
}));

// ============================================================
// useTraceLiveCountdown
// ============================================================

describe('useTraceLiveCountdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null label when capturedAt is null', () => {
    const { result } = renderHook(() => useTraceLiveCountdown(null));
    expect(result.current.label).toBeNull();
    expect(result.current.secondsRemaining).toBeNull();
    expect(result.current.isOverdue).toBe(false);
  });

  it('counts down to next-row-visible from the latest capture', () => {
    // Anchor = capturedAt + 10min cadence + 9min processing-p95 = 19 min.
    const t0 = new Date('2026-04-26T18:00:00Z').getTime();
    vi.setSystemTime(t0);
    const { result } = renderHook(() =>
      useTraceLiveCountdown('2026-04-26T18:00:00Z'),
    );
    expect(result.current.secondsRemaining).toBe(19 * 60);
    expect(result.current.label).toBe('19:00');
    expect(result.current.isOverdue).toBe(false);
  });

  it('updates the label every second', () => {
    const t0 = new Date('2026-04-26T18:00:00Z').getTime();
    vi.setSystemTime(t0);
    const { result } = renderHook(() =>
      useTraceLiveCountdown('2026-04-26T18:00:00Z'),
    );
    expect(result.current.label).toBe('19:00');
    act(() => {
      vi.advanceTimersByTime(7_000);
    });
    expect(result.current.label).toBe('18:53');
  });

  it('flips isOverdue when the deadline passes', () => {
    // 19-min anchor + 1 min late = overdue by 1:00.
    const t0 = new Date('2026-04-26T18:00:00Z').getTime();
    vi.setSystemTime(t0);
    const { result } = renderHook(() =>
      useTraceLiveCountdown('2026-04-26T18:00:00Z'),
    );
    act(() => {
      vi.advanceTimersByTime(20 * 60 * 1000); // 20 min after capture
    });
    expect(result.current.isOverdue).toBe(true);
    expect(result.current.secondsRemaining).toBe(-60);
    expect(result.current.label).toBe('1:00');
  });

  it('returns null label on invalid timestamp', () => {
    const { result } = renderHook(() => useTraceLiveCountdown('not-a-date'));
    expect(result.current.label).toBeNull();
  });
});

// ============================================================
// useTraceLiveChime
// ============================================================

describe('useTraceLiveChime', () => {
  let playChimeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Spy on the named export — vi.spyOn intercepts the binding the hook
    // resolves at module-import time, so we don't depend on JSDOM's effect-
    // flushing semantics or the WebAudio API being available.
    playChimeSpy = vi.spyOn(chimeAudio, 'playChime').mockImplementation(() => {
      /* no-op */
    });
  });

  afterEach(() => {
    playChimeSpy.mockRestore();
    vi.useRealTimers();
  });

  it('does not invoke playChime on first observation (existing-data load)', () => {
    renderHook(() =>
      useTraceLiveChime('2026-04-26T18:00:00Z', /* enabled */ true),
    );
    expect(playChimeSpy).not.toHaveBeenCalled();
  });

  it('invokes playChime when capturedAt changes after the first observation', async () => {
    const { rerender } = renderHook(
      ({ ts }: { ts: string | null }) => useTraceLiveChime(ts, true),
      { initialProps: { ts: '2026-04-26T18:00:00Z' } },
    );
    expect(playChimeSpy).not.toHaveBeenCalled();
    rerender({ ts: '2026-04-26T18:05:00Z' });
    expect(playChimeSpy).toHaveBeenCalledTimes(1);
  });

  it('does not chime when enabled is false', () => {
    const { rerender } = renderHook(
      ({ ts }: { ts: string | null }) => useTraceLiveChime(ts, false),
      { initialProps: { ts: '2026-04-26T18:00:00Z' } },
    );
    rerender({ ts: '2026-04-26T18:05:00Z' });
    expect(playChimeSpy).not.toHaveBeenCalled();
  });

  it('debounces a second change arriving within 1s', () => {
    vi.useFakeTimers();
    const t0 = new Date('2026-04-26T18:05:00Z').getTime();
    vi.setSystemTime(t0);
    const { rerender } = renderHook(
      ({ ts }: { ts: string | null }) => useTraceLiveChime(ts, true),
      { initialProps: { ts: '2026-04-26T18:00:00Z' } },
    );
    rerender({ ts: '2026-04-26T18:05:00Z' });
    vi.setSystemTime(t0 + 500); // 500ms later — under DEBOUNCE_MS
    rerender({ ts: '2026-04-26T18:05:01Z' });
    expect(playChimeSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

// ============================================================
// useTraceLiveData
// ============================================================

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  // Restore real timers in case any test forgot — prevents 15s timeouts
  // bleeding across blocks.
  vi.useRealTimers();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('useTraceLiveData', () => {
  it('fetches the list with the correct URL shape', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        date: '2026-04-26',
        count: 0,
        analyses: [],
      }),
    );
    renderHook(() => useTraceLiveData(/* marketOpen */ false));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toMatch(/^\/api\/trace-live-list\?date=\d{4}-\d{2}-\d{2}$/);
  });

  it('surfaces listError on fetch failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const { result } = renderHook(() => useTraceLiveData(false));
    await waitFor(() => expect(result.current.listError).not.toBeNull());
  });

  it('surfaces listError on non-OK HTTP status (other than 401)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500));
    const { result } = renderHook(() => useTraceLiveData(false));
    await waitFor(() => expect(result.current.listError).not.toBeNull());
  });

  it('does NOT surface listError on 401 (silent — non-owner path)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));
    const { result } = renderHook(() => useTraceLiveData(false));
    // Wait long enough for the fetch + setState chain to settle.
    await waitFor(() => expect(result.current.listLoading).toBe(false));
    expect(result.current.listError).toBeNull();
  });

  it('changes the URL when selectedDate changes', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ date: '', count: 0, analyses: [] }),
    );
    const { result } = renderHook(() => useTraceLiveData(false));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const initialCallCount = fetchMock.mock.calls.length;

    act(() => {
      result.current.setSelectedDate('2026-04-20');
    });

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(initialCallCount);
    });
    const lastCall = fetchMock.mock.calls.at(-1)![0] as string;
    expect(lastCall).toContain('date=2026-04-20');
  });

  it('polls again after POLL_INTERVALS.TRACE_LIVE in live mode', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock.mockResolvedValue(
      jsonResponse({ date: '', count: 0, analyses: [] }),
    );
    renderHook(() => useTraceLiveData(/* marketOpen */ true));
    // Initial fetch fires immediately.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // Advance through one full poll cycle.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    vi.useRealTimers();
  });
});
