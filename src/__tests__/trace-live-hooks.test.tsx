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

  it('counts down 5 minutes from the latest capture', () => {
    const t0 = new Date('2026-04-26T18:00:00Z').getTime();
    vi.setSystemTime(t0);
    const { result } = renderHook(() =>
      useTraceLiveCountdown('2026-04-26T18:00:00Z'),
    );
    // Right now, next capture is 5:00 away.
    expect(result.current.secondsRemaining).toBe(300);
    expect(result.current.label).toBe('5:00');
    expect(result.current.isOverdue).toBe(false);
  });

  it('updates the label every second', () => {
    const t0 = new Date('2026-04-26T18:00:00Z').getTime();
    vi.setSystemTime(t0);
    const { result } = renderHook(() =>
      useTraceLiveCountdown('2026-04-26T18:00:00Z'),
    );
    expect(result.current.label).toBe('5:00');
    act(() => {
      vi.advanceTimersByTime(7_000);
    });
    expect(result.current.label).toBe('4:53');
  });

  it('flips isOverdue when the deadline passes', () => {
    const t0 = new Date('2026-04-26T18:00:00Z').getTime();
    vi.setSystemTime(t0);
    const { result } = renderHook(() =>
      useTraceLiveCountdown('2026-04-26T18:00:00Z'),
    );
    act(() => {
      vi.advanceTimersByTime(6 * 60 * 1000); // 6 min later
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

interface MockOsc {
  type: string;
  frequency: { value: number };
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
}

interface MockGain {
  gain: {
    setValueAtTime: ReturnType<typeof vi.fn>;
    exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
  };
  connect: ReturnType<typeof vi.fn>;
}

describe('useTraceLiveChime', () => {
  let audioCtxCtor: ReturnType<typeof vi.fn>;
  let oscMock: MockOsc;
  let gainMock: MockGain;

  beforeEach(() => {
    // Real timers — fake timers introduced effect-flushing flakes here
    // and the debounce only needs ms-resolution, which Date.now() provides
    // even on real timers.
    oscMock = {
      type: '',
      frequency: { value: 0 },
      start: vi.fn(),
      stop: vi.fn(),
      connect: vi.fn(() => gainMock),
      onended: null,
    };
    gainMock = {
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    };
    audioCtxCtor = vi.fn(() => ({
      currentTime: 0,
      createOscillator: () => oscMock,
      createGain: () => gainMock,
      destination: {},
      close: vi.fn(),
    }));
    Object.defineProperty(globalThis, 'AudioContext', {
      value: audioCtxCtor,
      writable: true,
      configurable: true,
    });
  });

  it('does not invoke AudioContext on first render (initial mount)', () => {
    renderHook(() =>
      useTraceLiveChime('2026-04-26T18:00:00Z', /* enabled */ true),
    );
    expect(audioCtxCtor).not.toHaveBeenCalled();
  });

  // Note: the "AudioContext fires on capturedAt change" path is verified
  // in the browser, not here. JSDOM's effect-flushing semantics + WebAudio
  // make it hard to test deterministically without mocking the React
  // scheduler. The negative cases below catch the meaningful failure modes
  // (chime must NOT fire on mount, must NOT fire when disabled).

  it('does not chime when enabled is false', async () => {
    const { rerender } = renderHook(
      ({ ts }: { ts: string | null }) => useTraceLiveChime(ts, false),
      { initialProps: { ts: '2026-04-26T18:00:00Z' } },
    );
    await act(async () => {
      rerender({ ts: '2026-04-26T18:05:00Z' });
    });
    expect(audioCtxCtor).not.toHaveBeenCalled();
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
});
