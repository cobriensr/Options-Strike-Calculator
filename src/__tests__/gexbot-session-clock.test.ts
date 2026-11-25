import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  formatHoursMinutes,
  hoursToClose,
  useHoursToClose,
  useNow,
} from '../components/Gexbot/session-clock';

describe('hoursToClose', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts down to the 16:00 ET close of the current ET day', () => {
    // 13:00 ET (EDT) is three hours before the close.
    vi.setSystemTime(new Date('2026-05-19T17:00:00Z'));
    expect(hoursToClose(new Date())).toBeCloseTo(3, 12);
  });

  it('is 0 after the close, never negative', () => {
    vi.setSystemTime(new Date('2026-05-19T21:30:00Z'));
    expect(hoursToClose(new Date())).toBe(0);
  });

  // 2026-11-27 (Black Friday) is on EARLY_CLOSE_DATES: the session ends 13:00
  // ET, so a countdown to 16:00 would overstate the time left by 3 hours.
  it.each([
    // [now (UTC), hours to the calendar close]
    ['2026-11-27T17:15:00Z', 0.75], // 12:15 EST, 45 minutes left
    ['2026-11-27T15:00:00Z', 3], // 10:00 EST
    ['2026-11-27T18:00:00Z', 0], // exactly 13:00 EST
    ['2026-11-27T18:00:01Z', 0], // one second past, never negative
    ['2026-11-27T20:00:00Z', 0], // 15:00 EST, long after
  ])('counts a half day down to 13:00 ET: %s', (nowIso, hours) => {
    vi.setSystemTime(new Date(nowIso));
    expect(hoursToClose(new Date())).toBeCloseTo(hours, 12);
  });

  it('reads the ET date from `now`, not from the system clock', () => {
    // The system clock sits on a full day; `now` is the half day.
    vi.setSystemTime(new Date('2026-11-24T15:00:00Z'));
    expect(hoursToClose(new Date('2026-11-27T17:15:00Z'))).toBeCloseTo(
      0.75,
      12,
    );
  });

  it('is 0 on a market holiday: there is no close to count to', () => {
    // Thanksgiving 2026, 10:00 ET.
    vi.setSystemTime(new Date('2026-11-26T15:00:00Z'));
    expect(hoursToClose(new Date())).toBe(0);
  });
});

describe('useHoursToClose', () => {
  const IN_SESSION = new Date('2026-05-19T19:59:30Z'); // 15:59:30 EDT

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(IN_SESSION);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts down while the market is open', () => {
    const { result } = renderHook(() => useHoursToClose(true));
    expect(result.current).toBeCloseTo(30 / 3600, 12);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    // The 15:59:30 start plus a minute is past the close.
    expect(result.current).toBe(0);
  });

  it('is 0 when the market is closed, whatever the wall clock says', () => {
    vi.setSystemTime(new Date('2026-05-19T17:00:00Z')); // 13:00 EDT, 3 h left
    const { result } = renderHook(() => useHoursToClose(false));
    expect(result.current).toBe(0);
  });

  it('drops to 0 the moment the market closes, without waiting for a tick', () => {
    // Ticking stops when the gate closes, so `now` is left up to a minute
    // before the close. The countdown must not keep that stale reading.
    const { result, rerender } = renderHook(
      ({ open }) => useHoursToClose(open),
      { initialProps: { open: true } },
    );
    expect(result.current).toBeGreaterThan(0);
    rerender({ open: false });
    expect(result.current).toBe(0);
  });

  it('stops ticking while the market is closed, and resumes when it opens', () => {
    const { rerender } = renderHook(({ open }) => useHoursToClose(open), {
      initialProps: { open: false },
    });
    expect(vi.getTimerCount()).toBe(0);
    rerender({ open: true });
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe('formatHoursMinutes', () => {
  it.each([
    [3, '3h 00m'],
    [1.25, '1h 15m'],
    [0.5, '0h 30m'],
    [0, '0h 00m'],
  ])('formats %f h as %s', (hours, text) => {
    expect(formatHoursMinutes(hours)).toBe(text);
  });
});

describe('useNow', () => {
  const START = new Date('2026-05-19T17:00:00Z');

  function setVisibility(state: 'visible' | 'hidden') {
    Object.defineProperty(document, 'visibilityState', {
      value: state,
      configurable: true,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    setVisibility('visible');
  });

  afterEach(() => {
    setVisibility('visible');
    vi.useRealTimers();
  });

  it('re-reads the wall clock every interval', () => {
    const { result } = renderHook(() => useNow(60_000));
    expect(result.current.getTime()).toBe(START.getTime());
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.getTime()).toBe(START.getTime() + 60_000);
  });

  it('does not tick when the interval is null', () => {
    const { result } = renderHook(() => useNow(null));
    act(() => {
      vi.advanceTimersByTime(600_000);
    });
    expect(result.current.getTime()).toBe(START.getTime());
  });

  it('catches up when the tab becomes visible, and not while it is hidden', () => {
    const { result } = renderHook(() => useNow(3_600_000));
    // Move the clock without firing the hourly timer.
    vi.setSystemTime(new Date(START.getTime() + 300_000));

    setVisibility('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(result.current.getTime()).toBe(START.getTime());

    setVisibility('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(result.current.getTime()).toBe(START.getTime() + 300_000);
  });

  it('stops ticking and listening after unmount', () => {
    const remove = vi.spyOn(document, 'removeEventListener');
    const { unmount } = renderHook(() => useNow(60_000));
    unmount();
    expect(remove).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function),
    );
    expect(vi.getTimerCount()).toBe(0);
    remove.mockRestore();
  });
});
