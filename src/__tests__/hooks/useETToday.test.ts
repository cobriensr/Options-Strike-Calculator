import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useETToday } from '../../hooks/useETToday';

// Fake timers (setTimeout and Date) so the hook's midnight timer runs on
// the test's clock.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

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
