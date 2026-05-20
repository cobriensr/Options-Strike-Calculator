import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useTheme } from '../useTheme';

beforeEach(() => {
  window.localStorage.clear();
});

describe('useTheme', () => {
  it('defaults to dark mode on first visit (no LS key)', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.darkMode).toBe(true);
  });

  it("reads 'true' from legacy LS encoding", () => {
    window.localStorage.setItem('darkMode', 'true');
    const { result } = renderHook(() => useTheme());
    expect(result.current.darkMode).toBe(true);
  });

  it("reads 'false' from legacy LS encoding", () => {
    window.localStorage.setItem('darkMode', 'false');
    const { result } = renderHook(() => useTheme());
    expect(result.current.darkMode).toBe(false);
  });

  it("persists setDarkMode(true) as 'true'", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setDarkMode(true));
    expect(window.localStorage.getItem('darkMode')).toBe('true');
    expect(result.current.darkMode).toBe(true);
  });

  it("persists setDarkMode(false) as 'false'", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setDarkMode(false));
    expect(window.localStorage.getItem('darkMode')).toBe('false');
    expect(result.current.darkMode).toBe(false);
  });

  it('round-trips across remount via the legacy LS key', () => {
    const first = renderHook(() => useTheme());
    act(() => first.result.current.setDarkMode(false));
    first.unmount();

    const second = renderHook(() => useTheme());
    expect(second.result.current.darkMode).toBe(false);
  });

  it('treats arbitrary unrelated LS strings as `false`', () => {
    // Garbage values shouldn't bias dark mode the wrong way — only the
    // exact `'true'` string evaluates truthy under the legacy encoding.
    window.localStorage.setItem('darkMode', 'not-a-bool');
    const { result } = renderHook(() => useTheme());
    expect(result.current.darkMode).toBe(false);
  });
});
