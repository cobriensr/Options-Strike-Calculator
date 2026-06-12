import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePersistedFlag } from '../../hooks/usePersistedFlag';

const KEY = 'test.flag';

describe('usePersistedFlag', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to false when no stored value', () => {
    const { result } = renderHook(() => usePersistedFlag(KEY));
    expect(result.current[0]).toBe(false);
  });

  it('initializes true from a stored "1"', () => {
    localStorage.setItem(KEY, '1');
    const { result } = renderHook(() => usePersistedFlag(KEY));
    expect(result.current[0]).toBe(true);
  });

  it('persists set(true) to localStorage and updates state', () => {
    const { result } = renderHook(() => usePersistedFlag(KEY));
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
    expect(localStorage.getItem(KEY)).toBe('1');
  });

  it('persists set(false) as "0" and reads back false on remount', () => {
    const { result, unmount } = renderHook(() => usePersistedFlag(KEY));
    act(() => result.current[1](true));
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
    expect(localStorage.getItem(KEY)).toBe('0');
    unmount();
    const { result: remounted } = renderHook(() => usePersistedFlag(KEY));
    expect(remounted.current[0]).toBe(false);
  });

  it('degrades to in-memory state when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const { result } = renderHook(() => usePersistedFlag(KEY));
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
  });
});
