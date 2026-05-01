/**
 * Tests for `useWallClockFreshness` — wall-clock-based freshness check.
 *
 * Uses fake timers so tick + threshold transitions are deterministic. The
 * hook is owned by panels that need a defense-in-depth "is the displayed
 * snapshot actually live" signal independent of the polling machinery.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useWallClockFreshness,
  FRESHNESS_TICK_MS,
  DEFAULT_FRESHNESS_THRESHOLD_MS,
} from '../../hooks/useWallClockFreshness';

const FIXED_NOW = new Date('2026-04-30T12:00:00Z').getTime();

describe('useWallClockFreshness: exported constants', () => {
  it('FRESHNESS_TICK_MS is 1 second', () => {
    expect(FRESHNESS_TICK_MS).toBe(1000);
  });

  it('DEFAULT_FRESHNESS_THRESHOLD_MS is 60 seconds', () => {
    expect(DEFAULT_FRESHNESS_THRESHOLD_MS).toBe(60_000);
  });
});

describe('useWallClockFreshness: timestamp = null', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns isFresh=false and ageMs=null when timestamp is null', () => {
    const { result } = renderHook(() => useWallClockFreshness(null, 60_000));
    expect(result.current.isFresh).toBe(false);
    expect(result.current.ageMs).toBeNull();
    expect(result.current.nowMs).toBe(FIXED_NOW);
  });
});

describe('useWallClockFreshness: threshold crossing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('isFresh=true when timestamp is within threshold', () => {
    const tsMs = FIXED_NOW - 30_000; // 30s old
    const { result } = renderHook(() => useWallClockFreshness(tsMs, 60_000));
    expect(result.current.isFresh).toBe(true);
    expect(result.current.ageMs).toBe(30_000);
  });

  it('isFresh=false when timestamp is older than threshold', () => {
    const tsMs = FIXED_NOW - 90_000; // 90s old, threshold 60s
    const { result } = renderHook(() => useWallClockFreshness(tsMs, 60_000));
    expect(result.current.isFresh).toBe(false);
    expect(result.current.ageMs).toBe(90_000);
  });

  it('flips from fresh to stale as wall clock advances past threshold', () => {
    const tsMs = FIXED_NOW - 30_000; // start 30s old
    const { result } = renderHook(() =>
      useWallClockFreshness(tsMs, 60_000, { tickMs: 1000 }),
    );
    expect(result.current.isFresh).toBe(true);

    // Advance 35s — total age now 65s, > 60s threshold. The 1s ticker should
    // have fired enough times to refresh nowMs and re-render.
    act(() => {
      vi.advanceTimersByTime(35_000);
    });
    expect(result.current.isFresh).toBe(false);
  });

  it('uses default threshold when omitted', () => {
    const tsMs = FIXED_NOW - 30_000;
    const { result } = renderHook(() => useWallClockFreshness(tsMs));
    // 30_000 < DEFAULT_FRESHNESS_THRESHOLD_MS (60_000) → fresh
    expect(result.current.isFresh).toBe(true);
  });
});

describe('useWallClockFreshness: gates', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not tick when any gate is false', () => {
    const tsMs = FIXED_NOW - 30_000;
    const { result } = renderHook(() =>
      useWallClockFreshness(tsMs, 60_000, {
        gates: [true, false],
        tickMs: 1000,
      }),
    );
    const initialNow = result.current.nowMs;

    // Advance 5s. With gate closed, nowMs should NOT update.
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(result.current.nowMs).toBe(initialNow);
  });

  it('ticks when all gates are true', () => {
    const tsMs = FIXED_NOW - 30_000;
    const { result } = renderHook(() =>
      useWallClockFreshness(tsMs, 60_000, {
        gates: [true, true, true],
        tickMs: 1000,
      }),
    );
    const initialNow = result.current.nowMs;

    act(() => {
      vi.advanceTimersByTime(2_500);
    });
    expect(result.current.nowMs).toBeGreaterThan(initialNow);
  });

  it('starts ticking after a gate flips from false to true', () => {
    const tsMs = FIXED_NOW - 30_000;
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) =>
        useWallClockFreshness(tsMs, 60_000, {
          gates: [open],
          tickMs: 1000,
        }),
      { initialProps: { open: false } },
    );
    const initialNow = result.current.nowMs;

    // Advance with gate closed — no change.
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(result.current.nowMs).toBe(initialNow);

    // Open the gate.
    rerender({ open: true });

    // Now the ticker should fire and advance nowMs.
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(result.current.nowMs).toBeGreaterThan(initialNow);
  });

  it('stops ticking when a gate flips from true to false', () => {
    const tsMs = FIXED_NOW - 30_000;
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) =>
        useWallClockFreshness(tsMs, 60_000, {
          gates: [open],
          tickMs: 1000,
        }),
      { initialProps: { open: true } },
    );

    // Tick once with gate open.
    act(() => {
      vi.advanceTimersByTime(1_500);
    });
    const afterFirstTick = result.current.nowMs;

    // Close the gate.
    rerender({ open: false });

    // Advance — should stay at last value, no further ticks.
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(result.current.nowMs).toBe(afterFirstTick);
  });

  it('treats empty gates array as always-open', () => {
    const tsMs = FIXED_NOW - 30_000;
    const { result } = renderHook(() =>
      useWallClockFreshness(tsMs, 60_000, { gates: [], tickMs: 1000 }),
    );
    const initialNow = result.current.nowMs;
    act(() => {
      vi.advanceTimersByTime(1_500);
    });
    expect(result.current.nowMs).toBeGreaterThan(initialNow);
  });
});

describe('useWallClockFreshness: tickMs override', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('respects a custom tickMs (legacy 30s)', () => {
    const tsMs = FIXED_NOW - 30_000;
    const { result } = renderHook(() =>
      useWallClockFreshness(tsMs, 120_000, { tickMs: 30_000 }),
    );
    const initialNow = result.current.nowMs;

    // Advance 15s — under tickMs, no update yet.
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(result.current.nowMs).toBe(initialNow);

    // Advance to 30s total — first tick should have fired.
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(result.current.nowMs).toBeGreaterThan(initialNow);
  });
});
