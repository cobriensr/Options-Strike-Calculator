import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useQuoteStaleness } from '../../hooks/useQuoteStaleness';
import type { QuoteStaleness } from '../../hooks/useQuoteStaleness';
import type { MarketSession } from '../../hooks/useMarketData';

// The session is passed in, so the wall clock only matters for the age math.
const NOW = Date.UTC(2026, 3, 9, 14, 0, 0);
const TICK_MS = 5_000;

const FRESH_NULL: QuoteStaleness = {
  isStale: false,
  isVeryStale: false,
  staleAgeSec: null,
};

function fetchedSecondsAgo(sec: number): number {
  return NOW - sec * 1000;
}

/** Index of the hook's 5 s staleness interval among setInterval calls. */
function tickIntervalIndex(setSpy: { mock: { calls: unknown[][] } }): number {
  return setSpy.mock.calls.findIndex((call) => call[1] === TICK_MS);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useQuoteStaleness: thresholds', () => {
  it.each<[string, MarketSession, number | null, QuoteStaleness]>([
    ['closed session, old quotes → null', 'closed', 300, FRESH_NULL],
    ['no quotes fetched yet → null', 'regular', null, FRESH_NULL],
    [
      'fetched just now → fresh',
      'regular',
      0,
      { isStale: false, isVeryStale: false, staleAgeSec: 0 },
    ],
    [
      '89 s old → fresh',
      'regular',
      89,
      { isStale: false, isVeryStale: false, staleAgeSec: 89 },
    ],
    [
      '89.6 s old → rounds to 90 s but is not stale yet',
      'regular',
      89.6,
      { isStale: false, isVeryStale: false, staleAgeSec: 90 },
    ],
    [
      '90 s old → stale',
      'regular',
      90,
      { isStale: true, isVeryStale: false, staleAgeSec: 90 },
    ],
    [
      '179 s old → stale, not very stale',
      'regular',
      179,
      { isStale: true, isVeryStale: false, staleAgeSec: 179 },
    ],
    [
      '180 s old → very stale',
      'regular',
      180,
      { isStale: true, isVeryStale: true, staleAgeSec: 180 },
    ],
    [
      'pre-market counts as open → stale',
      'pre-market',
      90,
      { isStale: true, isVeryStale: false, staleAgeSec: 90 },
    ],
    [
      'after-hours counts as open → very stale',
      'after-hours',
      180,
      { isStale: true, isVeryStale: true, staleAgeSec: 180 },
    ],
    [
      'fetch stamped in the future (clock skew) → age clamps to 0',
      'regular',
      -3,
      { isStale: false, isVeryStale: false, staleAgeSec: 0 },
    ],
  ])('%s', (_label, session, ageSec, expected) => {
    const fetchedAt = ageSec == null ? null : fetchedSecondsAgo(ageSec);
    const { result } = renderHook(() => useQuoteStaleness(fetchedAt, session));
    expect(result.current).toEqual(expected);
  });
});

describe('useQuoteStaleness: clock tick', () => {
  it('goes fresh → stale → very stale as time passes, with no new inputs', () => {
    const { result } = renderHook(() => useQuoteStaleness(NOW, 'regular'));
    expect(result.current).toEqual({
      isStale: false,
      isVeryStale: false,
      staleAgeSec: 0,
    });

    act(() => {
      vi.advanceTimersByTime(90_000);
    });
    expect(result.current).toEqual({
      isStale: true,
      isVeryStale: false,
      staleAgeSec: 90,
    });

    act(() => {
      vi.advanceTimersByTime(90_000);
    });
    expect(result.current).toEqual({
      isStale: true,
      isVeryStale: true,
      staleAgeSec: 180,
    });
  });

  it('re-evaluates only every 5 s, so stale shows within one tick of 90 s', () => {
    const { result } = renderHook(() => useQuoteStaleness(NOW, 'regular'));

    // 89.999 s after the fetch, the last tick (85 s) still reads fresh.
    act(() => {
      vi.advanceTimersByTime(89_999);
    });
    expect(result.current.isStale).toBe(false);
    expect(result.current.staleAgeSec).toBe(85);

    // The 90 s tick flips it.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.isStale).toBe(true);
  });

  it('a newer fetch resets the age without waiting for a tick', () => {
    let fetchedAt = fetchedSecondsAgo(120);
    const { result, rerender } = renderHook(() =>
      useQuoteStaleness(fetchedAt, 'regular'),
    );
    expect(result.current.isStale).toBe(true);

    fetchedAt = NOW;
    rerender();
    expect(result.current).toEqual({
      isStale: false,
      isVeryStale: false,
      staleAgeSec: 0,
    });
  });

  it('starts no interval while the session is closed', () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    renderHook(() => useQuoteStaleness(fetchedSecondsAgo(300), 'closed'));
    expect(tickIntervalIndex(setSpy)).toBe(-1);
  });

  it('starts no interval until the first quotes fetch lands, then ticks', () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    let fetchedAt: number | null = null;
    const { result, rerender } = renderHook(() =>
      useQuoteStaleness(fetchedAt, 'regular'),
    );
    expect(tickIntervalIndex(setSpy)).toBe(-1);

    fetchedAt = NOW;
    rerender();
    expect(tickIntervalIndex(setSpy)).toBeGreaterThanOrEqual(0);

    act(() => {
      vi.advanceTimersByTime(90_000);
    });
    expect(result.current.isStale).toBe(true);
  });

  it('clears the interval and reports null when the session closes', () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    let session: MarketSession = 'after-hours';
    const { result, rerender } = renderHook(() =>
      useQuoteStaleness(fetchedSecondsAgo(100), session),
    );
    expect(result.current.isStale).toBe(true);
    const idx = tickIntervalIndex(setSpy);
    expect(idx).toBeGreaterThanOrEqual(0);
    const intervalId = setSpy.mock.results[idx]?.value;

    session = 'closed';
    rerender();
    expect(result.current).toEqual(FRESH_NULL);
    expect(clearSpy).toHaveBeenCalledWith(intervalId);
  });

  it('clears the interval on unmount', () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const { unmount } = renderHook(() => useQuoteStaleness(NOW, 'regular'));
    const idx = tickIntervalIndex(setSpy);
    expect(idx).toBeGreaterThanOrEqual(0);
    const intervalId = setSpy.mock.results[idx]?.value;

    unmount();
    expect(clearSpy).toHaveBeenCalledWith(intervalId);
  });
});
