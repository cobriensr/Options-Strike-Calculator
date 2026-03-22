import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDebounced } from '../../hooks/useDebounced';

describe('useDebounced', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns initial value immediately', () => {
    const { result } = renderHook(() => useDebounced('hello'));
    expect(result.current).toBe('hello');
  });

  it('does not update value before delay', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebounced(value, 250),
      { initialProps: { value: 'a' } },
    );
    rerender({ value: 'b' });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe('a');
  });

  it('updates value after delay', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebounced(value, 250),
      { initialProps: { value: 'a' } },
    );
    rerender({ value: 'b' });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(result.current).toBe('b');
  });

  it('resets timer on rapid changes', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebounced(value, 250),
      { initialProps: { value: 'a' } },
    );
    rerender({ value: 'b' });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    rerender({ value: 'c' });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    // 'b' should not have fired, still waiting for 'c'
    expect(result.current).toBe('a');
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current).toBe('c');
  });

  it('uses default delay of 250ms', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebounced(value),
      { initialProps: { value: 1 } },
    );
    rerender({ value: 2 });
    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(result.current).toBe(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(2);
  });

  it('respects custom delay', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebounced(value, 500),
      { initialProps: { value: 'x' } },
    );
    rerender({ value: 'y' });
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(result.current).toBe('x');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe('y');
  });
});
