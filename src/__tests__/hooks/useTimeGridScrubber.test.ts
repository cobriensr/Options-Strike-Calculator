import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  TIME_GRID,
  useTimeGridScrubber,
} from '../../hooks/useTimeGridScrubber';

describe('TIME_GRID constant', () => {
  it('has 79 5-minute slots from 08:30 to 15:00 CT', () => {
    // (15:00 - 08:30) / 5min = 78 intervals → 79 slots (inclusive)
    expect(TIME_GRID).toHaveLength(79);
    expect(TIME_GRID[0]).toBe('08:30');
    expect(TIME_GRID.at(-1)).toBe('15:00');
  });

  it('has every slot at a 5-min increment in HH:MM format', () => {
    for (const slot of TIME_GRID) {
      expect(slot).toMatch(/^\d{2}:\d{2}$/);
      const [h, m] = slot.split(':').map(Number);
      expect(m! % 5).toBe(0);
      expect(h! * 60 + m!).toBeGreaterThanOrEqual(8 * 60 + 30);
      expect(h! * 60 + m!).toBeLessThanOrEqual(15 * 60);
    }
  });
});

describe('useTimeGridScrubber', () => {
  beforeEach(() => {
    // Pin the clock to 11:42 CT (= 12:42 ET = 16:42 UTC during EDT, 17:42 UTC during EST)
    // so `lastGridTimeBeforeNow` is deterministic. Use a date during EDT.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T16:42:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts in live mode', () => {
    const { result } = renderHook(() => useTimeGridScrubber());
    expect(result.current.scrubTime).toBeNull();
    expect(result.current.isScrubbed).toBe(false);
    expect(result.current.canScrubPrev).toBe(true);
    expect(result.current.canScrubNext).toBe(false);
  });

  it('exposes the full TIME_GRID', () => {
    const { result } = renderHook(() => useTimeGridScrubber());
    expect(result.current.timeGrid).toBe(TIME_GRID);
  });

  it('scrubPrev from live anchors at the slot at-or-before now (CT)', () => {
    const { result } = renderHook(() => useTimeGridScrubber());
    act(() => result.current.scrubPrev());
    // Mocked clock = 11:42 CT → last slot at-or-before is 11:40
    expect(result.current.scrubTime).toBe('11:40');
    expect(result.current.isScrubbed).toBe(true);
  });

  it('scrubPrev from scrubbed steps one slot earlier', () => {
    const { result } = renderHook(() => useTimeGridScrubber());
    act(() => result.current.scrubTo('10:30'));
    expect(result.current.scrubTime).toBe('10:30');
    act(() => result.current.scrubPrev());
    expect(result.current.scrubTime).toBe('10:25');
  });

  it('scrubPrev clamps at the first slot', () => {
    const { result } = renderHook(() => useTimeGridScrubber());
    act(() => result.current.scrubTo('08:30'));
    expect(result.current.canScrubPrev).toBe(false);
    act(() => result.current.scrubPrev());
    expect(result.current.scrubTime).toBe('08:30');
  });

  it('scrubNext from scrubbed steps one slot later', () => {
    const { result } = renderHook(() => useTimeGridScrubber());
    act(() => result.current.scrubTo('10:30'));
    act(() => result.current.scrubNext());
    expect(result.current.scrubTime).toBe('10:35');
  });

  it('scrubNext is a no-op in live mode', () => {
    const { result } = renderHook(() => useTimeGridScrubber());
    act(() => result.current.scrubNext());
    expect(result.current.scrubTime).toBeNull();
  });

  it('scrubNext clamps at the last slot', () => {
    const { result } = renderHook(() => useTimeGridScrubber());
    act(() => result.current.scrubTo('14:55'));
    act(() => result.current.scrubNext());
    expect(result.current.scrubTime).toBe('15:00');
    expect(result.current.canScrubNext).toBe(false);
    act(() => result.current.scrubNext());
    expect(result.current.scrubTime).toBe('15:00');
  });

  it('scrubTo(lastSlot) resumes live mode', () => {
    const { result } = renderHook(() => useTimeGridScrubber());
    act(() => result.current.scrubTo('10:30'));
    expect(result.current.isScrubbed).toBe(true);
    act(() => result.current.scrubTo('15:00'));
    expect(result.current.scrubTime).toBeNull();
    expect(result.current.isScrubbed).toBe(false);
  });

  it('scrubTo ignores values not in the grid', () => {
    const { result } = renderHook(() => useTimeGridScrubber());
    act(() => result.current.scrubTo('10:00'));
    expect(result.current.scrubTime).toBe('10:00');
    act(() => result.current.scrubTo('not-a-slot'));
    expect(result.current.scrubTime).toBe('10:00');
    act(() => result.current.scrubTo('07:00'));
    expect(result.current.scrubTime).toBe('10:00');
  });

  it('scrubLive returns to null', () => {
    const { result } = renderHook(() => useTimeGridScrubber());
    act(() => result.current.scrubTo('10:30'));
    act(() => result.current.scrubLive());
    expect(result.current.scrubTime).toBeNull();
    expect(result.current.isScrubbed).toBe(false);
  });

  it('canScrubPrev: true from live, false at first slot, true otherwise', () => {
    const { result } = renderHook(() => useTimeGridScrubber());
    expect(result.current.canScrubPrev).toBe(true); // live
    act(() => result.current.scrubTo('08:30'));
    expect(result.current.canScrubPrev).toBe(false); // first slot
    act(() => result.current.scrubTo('10:00'));
    expect(result.current.canScrubPrev).toBe(true);
  });
});
