/**
 * Tests for `usePolling` — gated `setInterval` primitive.
 *
 * Uses fake timers so gate flips and tick advancements are deterministic.
 * The hook is owned by polling consumers (`useMarketData`, `useGexPerStrike`,
 * `useGexTarget`) so this suite covers the contract those consumers rely on:
 *
 *   - schedules but never fires `fn` immediately
 *   - empty gates array = always-active
 *   - any false gate stops the interval
 *   - gate flip on/off starts/stops the interval
 *   - latest `fn` is captured by ref (no re-schedule on `fn` change)
 *   - `intervalMs` change re-schedules with the new cadence
 *   - cleanup on unmount
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePolling } from '../../hooks/usePolling';

describe('usePolling: scheduling semantics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not call fn immediately on mount', () => {
    const fn = vi.fn();
    renderHook(() => usePolling(fn, 1000, []));
    expect(fn).not.toHaveBeenCalled();
  });

  it('calls fn after intervalMs elapses', () => {
    const fn = vi.fn();
    renderHook(() => usePolling(fn, 1000, []));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('calls fn repeatedly at intervalMs cadence', () => {
    const fn = vi.fn();
    renderHook(() => usePolling(fn, 1000, []));
    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe('usePolling: empty gates = always-active', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs when gates array is empty', () => {
    const fn = vi.fn();
    renderHook(() => usePolling(fn, 500, []));
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(fn).toHaveBeenCalledTimes(4);
  });
});

describe('usePolling: gate behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not run when any gate is false', () => {
    const fn = vi.fn();
    renderHook(() => usePolling(fn, 1000, [true, false]));
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('runs when all gates are true', () => {
    const fn = vi.fn();
    renderHook(() => usePolling(fn, 1000, [true, true, true]));
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('starts polling when a gate flips from false to true', () => {
    const fn = vi.fn();
    const { rerender } = renderHook(
      ({ open }: { open: boolean }) => usePolling(fn, 1000, [open]),
      { initialProps: { open: false } },
    );

    // Gate closed — no fires.
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(fn).not.toHaveBeenCalled();

    // Open the gate.
    rerender({ open: true });

    // Now polling fires.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('stops polling when a gate flips from true to false', () => {
    const fn = vi.fn();
    const { rerender } = renderHook(
      ({ open }: { open: boolean }) => usePolling(fn, 1000, [open]),
      { initialProps: { open: true } },
    );

    // Gate open — fires.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(fn).toHaveBeenCalledTimes(2);

    // Close the gate.
    rerender({ open: false });

    // No further fires.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('handles a multi-gate conjunction flipping', () => {
    const fn = vi.fn();
    const { rerender } = renderHook(
      ({ a, b }: { a: boolean; b: boolean }) => usePolling(fn, 1000, [a, b]),
      { initialProps: { a: true, b: true } },
    );

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(fn).toHaveBeenCalledTimes(1);

    // Flip just one gate to false — interval stops.
    rerender({ a: true, b: false });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(fn).toHaveBeenCalledTimes(1);

    // Flip back — interval resumes.
    rerender({ a: true, b: true });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('usePolling: latest fn captured by ref', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the latest fn reference without re-scheduling', () => {
    const fnA = vi.fn();
    const fnB = vi.fn();
    const { rerender } = renderHook(
      ({ fn }: { fn: () => void }) => usePolling(fn, 1000, []),
      { initialProps: { fn: fnA } },
    );

    // First tick — fnA fires.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(fnA).toHaveBeenCalledTimes(1);
    expect(fnB).not.toHaveBeenCalled();

    // Swap to fnB without re-scheduling. Advance another full interval — the
    // existing interval (which was set up with fnA's ref-bound handler)
    // should now invoke fnB because the ref was updated in render.
    rerender({ fn: fnB });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(fnA).toHaveBeenCalledTimes(1); // no further calls
    expect(fnB).toHaveBeenCalledTimes(1);
  });

  it('does not reset the timer when fn changes mid-interval', () => {
    const fn = vi.fn();
    const { rerender } = renderHook(
      ({ marker }: { marker: number }) =>
        usePolling(() => fn(marker), 1000, []),
      { initialProps: { marker: 1 } },
    );

    // Advance halfway through the interval.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(fn).not.toHaveBeenCalled();

    // Swap fn (via the closure capturing `marker`). Timer should NOT reset —
    // we only need 500ms more to trigger the first fire.
    rerender({ marker: 2 });

    act(() => {
      vi.advanceTimersByTime(500);
    });
    // Fired exactly once, and used the latest `marker`.
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(2);
  });
});

describe('usePolling: intervalMs change', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-schedules with the new interval', () => {
    const fn = vi.fn();
    const { rerender } = renderHook(
      ({ ms }: { ms: number }) => usePolling(fn, ms, []),
      { initialProps: { ms: 1000 } },
    );

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(fn).toHaveBeenCalledTimes(1);

    // Switch to a faster cadence.
    rerender({ ms: 250 });

    // The old interval was cleared; the new one fires at 250ms cadence.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(fn).toHaveBeenCalledTimes(5); // 1 + 4 new
  });

  it('resets the timer on intervalMs change', () => {
    const fn = vi.fn();
    const { rerender } = renderHook(
      ({ ms }: { ms: number }) => usePolling(fn, ms, []),
      { initialProps: { ms: 1000 } },
    );

    // Advance halfway through the original interval.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(fn).not.toHaveBeenCalled();

    // Change interval — old timer cleared, new timer started fresh.
    rerender({ ms: 800 });

    // The original 1000ms timer would have fired by now (500 + 600 = 1100ms
    // of advancement, only 500ms used pre-rerender). Confirm the partial
    // 500ms was discarded by NOT firing yet at 600ms after rerender.
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(fn).not.toHaveBeenCalled();

    // 200ms more reaches the new 800ms cadence — first fire.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('usePolling: cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears the interval on unmount', () => {
    const fn = vi.fn();
    const { unmount } = renderHook(() => usePolling(fn, 1000, []));

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(fn).toHaveBeenCalledTimes(1);

    unmount();

    // No further fires after unmount.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('clears the interval when a gate flips closed (no leak)', () => {
    const fn = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ open }: { open: boolean }) => usePolling(fn, 1000, [open]),
      { initialProps: { open: true } },
    );

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(fn).toHaveBeenCalledTimes(1);

    // Close gate. Existing interval cleared.
    rerender({ open: false });

    // Unmount with gate already closed — should not throw or leak.
    expect(() => unmount()).not.toThrow();
  });
});
