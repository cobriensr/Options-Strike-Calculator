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

  it('parses #alerts with a query suffix as alerts (deep-link variant)', () => {
    history.replaceState(null, '', '/#alerts?ref=email');
    const { result } = renderHook(() => useViewMode());
    expect(result.current.view).toBe('alerts');
  });

  it('setView creates symmetric history entries so Back round-trips between views', () => {
    const { result } = renderHook(() => useViewMode());
    act(() => result.current.setView('alerts'));
    // pushState (not hash assignment) wrote the alerts URL.
    expect(window.location.hash).toBe('#alerts');
    act(() => result.current.setView('calculator'));
    // pushState for the calculator direction too — symmetric, hash cleared.
    expect(window.location.hash).toBe('');
    // Back returns to the alerts URL. jsdom's history.back() does not restore
    // the URL from its stack (and does not fire popstate synchronously), so we
    // simulate Back by restoring the prior URL and dispatching popstate. The
    // assertion under test is the listener-driven transition: the popstate
    // handler must re-read the (now #alerts) hash and flip view to 'alerts'.
    act(() => {
      history.replaceState(null, '', '/#alerts');
      window.dispatchEvent(new Event('popstate'));
    });
    expect(window.location.hash).toBe('#alerts');
    expect(result.current.view).toBe('alerts');
  });

  it('responds to popstate (browser back/forward)', () => {
    history.replaceState(null, '', '/#alerts');
    const { result } = renderHook(() => useViewMode());
    expect(result.current.view).toBe('alerts');
    act(() => {
      history.replaceState(null, '', '/');
      window.dispatchEvent(new Event('popstate'));
    });
    expect(result.current.view).toBe('calculator');
  });

  it('removes both hashchange and popstate listeners on unmount', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useViewMode());
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('hashchange', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('popstate', expect.any(Function));
  });
});
