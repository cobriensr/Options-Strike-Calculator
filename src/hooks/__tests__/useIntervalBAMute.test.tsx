// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIntervalBAMute } from '../useIntervalBAMute';

const STORAGE_KEY = 'sc-interval-ba-muted-v1';

beforeEach(() => {
  window.localStorage.clear();
});

describe('useIntervalBAMute', () => {
  it('defaults to unmuted when localStorage is empty', () => {
    const { result } = renderHook(() => useIntervalBAMute());
    expect(result.current.muted).toBe(false);
  });

  it('seeds from localStorage synchronously on first render', () => {
    window.localStorage.setItem(STORAGE_KEY, '1');
    const { result } = renderHook(() => useIntervalBAMute());
    expect(result.current.muted).toBe(true);
  });

  it('toggle flips the muted state', () => {
    const { result } = renderHook(() => useIntervalBAMute());
    act(() => result.current.toggle());
    expect(result.current.muted).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.muted).toBe(false);
  });

  it('setMuted(true) persists to localStorage', () => {
    const { result } = renderHook(() => useIntervalBAMute());
    act(() => result.current.setMuted(true));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('1');
  });

  it('setMuted(false) removes the localStorage entry', () => {
    window.localStorage.setItem(STORAGE_KEY, '1');
    const { result } = renderHook(() => useIntervalBAMute());
    act(() => result.current.setMuted(false));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('ignores corrupt localStorage value (any non-"1" string is unmuted)', () => {
    window.localStorage.setItem(STORAGE_KEY, 'true');
    const { result } = renderHook(() => useIntervalBAMute());
    expect(result.current.muted).toBe(false);
  });
});
