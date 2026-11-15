import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Fragment, StrictMode, createElement, memo } from 'react';
import { act, render, renderHook } from '@testing-library/react';
import { useETToday } from '../../hooks/useETToday';

// The clock's store is module-private, so the one test that needs the store
// itself (a plain listener, to count its notifications) reads the subscribe
// function React was handed. Everything else goes through the hook.
const captured = vi.hoisted(() => ({
  subscribe: null as null | ((listener: () => void) => () => void),
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useSyncExternalStore: ((subscribe, getSnapshot, getServerSnapshot) => {
      captured.subscribe = subscribe;
      return actual.useSyncExternalStore(
        subscribe,
        getSnapshot,
        getServerSnapshot,
      );
    }) as typeof actual.useSyncExternalStore,
  };
});

// Fake timers (setTimeout and Date) so the hook's midnight timer runs on
// the test's clock.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  // The add/removeEventListener spies on window and document.
  vi.restoreAllMocks();
  vi.useRealTimers();
  // Back to jsdom's own visibilityState.
  Reflect.deleteProperty(document, 'visibilityState');
});

/** Make the tab visible or hidden, as a browser reports it. */
function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

/** The tab comes back (visible) after the laptop slept. */
function becomeVisible() {
  setVisibility('visible');
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('useETToday', () => {
  it("returns today's ET date, not the UTC date", () => {
    // 21:00 EDT on 03-10 is 01:00Z on 03-11.
    vi.setSystemTime(new Date('2026-03-11T01:00:00Z'));
    const { result } = renderHook(() => useETToday());
    expect(result.current).toBe('2026-03-10');
  });

  it('turns over at ET midnight without any other render', () => {
    vi.setSystemTime(new Date('2026-03-11T03:59:30Z')); // 23:59:30 EDT
    const { result } = renderHook(() => useETToday());
    expect(result.current).toBe('2026-03-10');

    act(() => {
      vi.advanceTimersByTime(29_000); // 23:59:59
    });
    expect(result.current).toBe('2026-03-10');

    act(() => {
      vi.advanceTimersByTime(2_000); // just past midnight
    });
    expect(result.current).toBe('2026-03-11');
  });

  it('keeps turning over on later nights', () => {
    vi.setSystemTime(new Date('2026-03-11T03:59:30Z'));
    const { result } = renderHook(() => useETToday());

    act(() => {
      vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 31_000);
    });
    expect(result.current).toBe('2026-03-12');
  });

  it('turns over on time on a DST day (the wall clock skips an hour)', () => {
    // 00:30 EST on Sun 2026-03-08. Clocks jump 02:00 → 03:00, so the next
    // ET midnight is 22.5 real hours away, not the wall clock's 23.5.
    vi.setSystemTime(new Date('2026-03-08T05:30:00Z'));
    const { result } = renderHook(() => useETToday());

    act(() => {
      vi.advanceTimersByTime(22.5 * 60 * 60 * 1000 + 2_000);
    });
    expect(result.current).toBe('2026-03-09');
  });

  it('re-renders only when the date changes', () => {
    vi.setSystemTime(new Date('2026-03-10T15:00:00Z')); // 11:00 EDT
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useETToday();
    });
    const afterMount = renders;

    // Hourly checks through the afternoon find the same date.
    act(() => {
      vi.advanceTimersByTime(12 * 60 * 60 * 1000);
    });
    expect(renders).toBe(afterMount);
  });

  it('clears its timer on unmount', () => {
    vi.setSystemTime(new Date('2026-03-10T15:00:00Z'));
    const { unmount } = renderHook(() => useETToday());
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// --------------------------------------------------------
// One clock for every caller. The store arms one timer while anyone is
// subscribed, holds the date every subscriber reads, and re-checks the wall
// clock when a sleeping laptop or a throttled tab may have missed the timer.
// --------------------------------------------------------
describe('useETToday as one shared clock', () => {
  it('runs one timer however many components read it', () => {
    vi.setSystemTime(new Date('2026-03-10T15:00:00Z'));
    const a = renderHook(() => useETToday());
    const b = renderHook(() => useETToday());
    const c = renderHook(() => useETToday());
    expect(vi.getTimerCount()).toBe(1);

    a.unmount();
    b.unmount();
    expect(vi.getTimerCount()).toBe(1);

    c.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('flips every reader at the tick, memoized or not', () => {
    vi.setSystemTime(new Date('2026-03-11T03:59:30Z')); // 23:59:30 EDT
    const seen: Array<{ id: string; today: string }> = [];
    // memo with no props: only the clock can re-render these.
    const Reader = memo(function Reader({ id }: { id: string }) {
      const today = useETToday();
      seen.push({ id, today });
      return null;
    });
    render(
      createElement(
        Fragment,
        null,
        createElement(Reader, { id: 'a' }),
        createElement(Reader, { id: 'b' }),
        createElement(Reader, { id: 'c' }),
      ),
    );
    expect(seen.map((s) => s.today)).toEqual(Array(3).fill('2026-03-10'));
    seen.length = 0;

    act(() => {
      vi.advanceTimersByTime(31_000);
    });

    expect(seen).toEqual([
      { id: 'a', today: '2026-03-11' },
      { id: 'b', today: '2026-03-11' },
      { id: 'c', today: '2026-03-11' },
    ]);
  });

  it('lets a reader that mounts late agree with the others, not the wall clock', () => {
    vi.setSystemTime(new Date('2026-03-11T03:59:30Z'));
    const early = renderHook(() => useETToday());

    // Past midnight on the wall clock; the timer (armed for 1 s past it) has
    // not fired, so the clock still says the 10th.
    act(() => {
      vi.setSystemTime(new Date('2026-03-11T04:00:00.500Z'));
    });
    const late = renderHook(() => useETToday());
    expect(early.result.current).toBe('2026-03-10');
    expect(late.result.current).toBe('2026-03-10');

    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    expect(early.result.current).toBe('2026-03-11');
    expect(late.result.current).toBe('2026-03-11');
  });

  it('reads the wall clock afresh when nothing was mounted', () => {
    vi.setSystemTime(new Date('2026-03-10T15:00:00Z'));
    const first = renderHook(() => useETToday());
    expect(first.result.current).toBe('2026-03-10');
    first.unmount();

    // Days later, a new first reader must not see the old held date. Its
    // first render is the one that would: subscribing re-reads the clock, so
    // the committed value is right even when the first render was not.
    vi.setSystemTime(new Date('2026-03-14T15:00:00Z'));
    const seen: string[] = [];
    renderHook(() => {
      const today = useETToday();
      seen.push(today);
      return today;
    });
    expect(seen[0]).toBe('2026-03-14');
  });

  describe('re-checks the wall clock after a sleep or a throttled tab', () => {
    // The tab slept through ET midnight: the wall clock moved, no timer fired.
    function sleepPastMidnight() {
      vi.setSystemTime(new Date('2026-03-11T03:59:30Z')); // 23:59:30 EDT
      const hook = renderHook(() => useETToday());
      expect(hook.result.current).toBe('2026-03-10');
      act(() => {
        vi.setSystemTime(new Date('2026-03-11T09:00:00Z')); // 05:00 EDT
      });
      expect(hook.result.current).toBe('2026-03-10');
      return hook;
    }

    it('on visibilitychange to visible', () => {
      const { result } = sleepPastMidnight();

      act(() => {
        becomeVisible();
      });

      expect(result.current).toBe('2026-03-11');
    });

    it('not on visibilitychange to hidden', () => {
      const { result } = sleepPastMidnight();

      act(() => {
        setVisibility('hidden');
        document.dispatchEvent(new Event('visibilitychange'));
      });

      expect(result.current).toBe('2026-03-10');
    });

    it('on window focus', () => {
      const { result } = sleepPastMidnight();

      act(() => {
        window.dispatchEvent(new Event('focus'));
      });

      expect(result.current).toBe('2026-03-11');
    });
  });

  // This guards an optimization with no visible effect: React already bails
  // out of a notification whose snapshot is unchanged, so no render-count
  // test can tell a store that notifies on every check from one that doesn't.
  // A plain listener on the store can.
  it('notifies a subscriber only when the date changed', () => {
    vi.setSystemTime(new Date('2026-03-10T15:00:00Z')); // 11:00 EDT
    renderHook(() => useETToday());
    const listener = vi.fn();
    const unsubscribe = captured.subscribe!(listener);

    // The store outlives the test while a listener is on it, so a failed
    // assertion must not leave this one behind for the next test.
    try {
      // Hourly timer checks, a focus and a visibility change: all find the
      // same date.
      act(() => {
        vi.advanceTimersByTime(3 * 60 * 60 * 1000);
        window.dispatchEvent(new Event('focus'));
        becomeVisible();
      });
      expect(listener).not.toHaveBeenCalled();

      // Past midnight: one notification for the new date, none for a repeat.
      act(() => {
        vi.setSystemTime(new Date('2026-03-11T05:00:00Z'));
        window.dispatchEvent(new Event('focus'));
      });
      expect(listener).toHaveBeenCalledTimes(1);
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  describe('in StrictMode (subscribe, unsubscribe, subscribe again)', () => {
    it('leaves one timer while mounted and none after', () => {
      vi.setSystemTime(new Date('2026-03-10T15:00:00Z'));
      const { unmount } = renderHook(() => useETToday(), {
        wrapper: StrictMode,
      });
      expect(vi.getTimerCount()).toBe(1);

      unmount();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('removes every listener it added', () => {
      vi.setSystemTime(new Date('2026-03-10T15:00:00Z'));
      const addWindow = vi.spyOn(window, 'addEventListener');
      const removeWindow = vi.spyOn(window, 'removeEventListener');
      const addDocument = vi.spyOn(document, 'addEventListener');
      const removeDocument = vi.spyOn(document, 'removeEventListener');

      const { unmount } = renderHook(() => useETToday(), {
        wrapper: StrictMode,
      });
      unmount();

      const added = (spy: typeof addWindow, type: string) =>
        spy.mock.calls.filter(([t]) => t === type).map(([, fn]) => fn);
      expect(added(addWindow, 'focus').length).toBeGreaterThan(0);
      expect(added(addDocument, 'visibilitychange').length).toBeGreaterThan(0);
      expect(added(removeWindow, 'focus')).toEqual(added(addWindow, 'focus'));
      expect(added(removeDocument, 'visibilitychange')).toEqual(
        added(addDocument, 'visibilitychange'),
      );
    });
  });
});
