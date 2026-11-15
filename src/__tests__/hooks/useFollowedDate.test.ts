import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useFollowedDate } from '../../hooks/useFollowedDate';

// The shared ET clock ticks on setTimeout, so fake that as well as Date.
// Every case starts 30 s before an ET midnight; the clock's timer is armed
// for 1 s past it, so 31 s lands just after.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

const midnights = [
  {
    zone: 'EST (winter)',
    start: '2026-11-10T04:59:30Z',
    night: '2026-11-09',
    morning: '2026-11-10',
    nextMidnight: '2026-11-11T04:59:30Z',
    nextMorning: '2026-11-11',
  },
  {
    zone: 'EDT (summer)',
    start: '2026-07-15T03:59:30Z',
    night: '2026-07-14',
    morning: '2026-07-15',
    nextMidnight: '2026-07-16T03:59:30Z',
    nextMorning: '2026-07-16',
  },
];

function crossMidnight() {
  act(() => {
    vi.advanceTimersByTime(31_000);
  });
}

describe.each(midnights)('useFollowedDate at the $zone midnight', (m) => {
  beforeEach(() => {
    vi.setSystemTime(new Date(m.start));
  });

  it('follows today by default, across the midnight', () => {
    const { result } = renderHook(() => useFollowedDate());
    expect(result.current.date).toBe(m.night);
    expect(result.current.today).toBe(m.night);

    crossMidnight();

    expect(result.current.date).toBe(m.morning);
    expect(result.current.today).toBe(m.morning);
  });

  it('keeps a picked past date', () => {
    const { result } = renderHook(() => useFollowedDate());
    act(() => {
      result.current.setDate('2026-03-11');
    });
    expect(result.current.date).toBe('2026-03-11');

    crossMidnight();

    expect(result.current.date).toBe('2026-03-11');
    expect(result.current.today).toBe(m.morning);
  });

  it('keeps a picked future date, which is the new today after midnight', () => {
    const { result } = renderHook(() => useFollowedDate());
    act(() => {
      result.current.setDate(m.morning);
    });
    expect(result.current.date).toBe(m.morning);

    crossMidnight();

    expect(result.current.date).toBe(m.morning);
    expect(result.current.today).toBe(m.morning);
    expect(result.current.date).toBe(result.current.today);

    // A far-off date stays too.
    act(() => {
      result.current.setDate('2026-12-25');
    });
    expect(result.current.date).toBe('2026-12-25');
  });

  it("follows again once today's date is picked", () => {
    const { result } = renderHook(() => useFollowedDate());
    act(() => {
      result.current.setDate('2026-03-11');
    });
    act(() => {
      result.current.setDate(m.night);
    });
    expect(result.current.date).toBe(m.night);

    crossMidnight();

    expect(result.current.date).toBe(m.morning);
  });

  it('follows when the date is emptied, instead of holding the empty string', () => {
    const { result } = renderHook(() => useFollowedDate());
    act(() => {
      result.current.setDate('2026-03-11');
    });
    act(() => {
      result.current.setDate('');
    });
    expect(result.current.date).toBe(m.night);

    crossMidnight();

    expect(result.current.date).toBe(m.morning);
  });

  it('follows a pick of the new today made before the clock ticks', () => {
    const { result } = renderHook(() => useFollowedDate());

    // Past ET midnight on the wall clock, but the shared clock's timer
    // (armed for 1 s past it) has not fired, so `today` still says night.
    act(() => {
      vi.setSystemTime(new Date(Date.parse(m.start) + 31_000));
    });
    expect(result.current.today).toBe(m.night);
    act(() => {
      result.current.setDate(m.morning);
    });
    crossMidnight();
    expect(result.current.date).toBe(m.morning);

    // The pick was "today", not that date: the next midnight carries it on.
    // An hour is the longest wait between the clock's checks.
    act(() => {
      vi.setSystemTime(new Date(m.nextMidnight));
    });
    act(() => {
      vi.advanceTimersByTime(60 * 60 * 1000);
    });
    expect(result.current.date).toBe(m.nextMorning);
  });

  it('keeps setDate the same function across renders and the rollover', () => {
    const { result, rerender } = renderHook(() => useFollowedDate());
    const before = result.current.setDate;

    rerender();
    crossMidnight();
    act(() => {
      result.current.setDate('2026-03-11');
    });

    expect(result.current.setDate).toBe(before);
  });
});
