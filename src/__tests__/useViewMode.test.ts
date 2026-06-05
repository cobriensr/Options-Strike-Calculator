import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useViewMode } from '../hooks/useViewMode';

beforeEach(() => {
  // Reset to a clean URL with no hash before each case.
  history.replaceState(null, '', '/');
});

describe('useViewMode', () => {
  it('defaults to calculator when there is no hash', () => {
    const { result } = renderHook(() => useViewMode());
    expect(result.current.view).toBe('calculator');
  });

  it('reads alerts when the initial hash is #alerts', () => {
    history.replaceState(null, '', '/#alerts');
    const { result } = renderHook(() => useViewMode());
    expect(result.current.view).toBe('alerts');
  });

  it('setView("alerts") sets the hash and updates the view', () => {
    const { result } = renderHook(() => useViewMode());
    act(() => result.current.setView('alerts'));
    expect(window.location.hash).toBe('#alerts');
    expect(result.current.view).toBe('alerts');
  });

  it('setView("calculator") clears the hash and updates the view', () => {
    history.replaceState(null, '', '/#alerts');
    const { result } = renderHook(() => useViewMode());
    act(() => result.current.setView('calculator'));
    expect(window.location.hash).toBe('');
    expect(result.current.view).toBe('calculator');
  });

  it('responds to external hashchange events (back/forward)', () => {
    const { result } = renderHook(() => useViewMode());
    expect(result.current.view).toBe('calculator');
    act(() => {
      history.replaceState(null, '', '/#alerts');
      window.dispatchEvent(new Event('hashchange'));
    });
    expect(result.current.view).toBe('alerts');
  });

  it('removes its hashchange listener on unmount', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useViewMode());
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('hashchange', expect.any(Function));
  });
});
