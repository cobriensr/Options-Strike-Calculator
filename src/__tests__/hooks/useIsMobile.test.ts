import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIsMobile } from '../../hooks/useIsMobile';

/**
 * MockMediaQueryList — minimal stub of MediaQueryList that lets each test
 * flip `matches` and trigger `change` listeners on demand.
 *
 * We only stub `matchMedia` (per CLAUDE.md guidance) — never the whole
 * `window` object.
 */
function createMatchMediaStub(initialMatches: boolean) {
  type Listener = (e: { matches: boolean }) => void;
  const listeners = new Set<Listener>();
  let matches = initialMatches;

  const addEventListener = vi.fn(
    (event: string, cb: EventListenerOrEventListenerObject) => {
      if (event === 'change') listeners.add(cb as unknown as Listener);
    },
  );
  const removeEventListener = vi.fn(
    (event: string, cb: EventListenerOrEventListenerObject) => {
      if (event === 'change') listeners.delete(cb as unknown as Listener);
    },
  );

  const mql = {
    get matches() {
      return matches;
    },
    media: '(max-width: 767px)',
    addEventListener,
    removeEventListener,
    // legacy fallbacks not used by useIsMobile but required by the type
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList;

  const matchMedia = vi.fn(() => mql);

  return {
    matchMedia,
    addEventListener,
    removeEventListener,
    setMatches(next: boolean) {
      matches = next;
      for (const cb of listeners) cb({ matches });
    },
    listenerCount: () => listeners.size,
  };
}

describe('useIsMobile', () => {
  const originalMatchMedia = window.matchMedia;

  afterEach(() => {
    // Restore matchMedia between tests so cross-test contamination is impossible.
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
  });

  it('returns true when the viewport is at or below the mobile breakpoint', () => {
    const stub = createMatchMediaStub(true);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: stub.matchMedia,
    });

    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
    expect(stub.matchMedia).toHaveBeenCalledWith('(max-width: 767px)');
  });

  it('returns false when the viewport is above the mobile breakpoint', () => {
    const stub = createMatchMediaStub(false);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: stub.matchMedia,
    });

    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });

  it('re-renders with the new value when the media query crosses the breakpoint', () => {
    const stub = createMatchMediaStub(false);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: stub.matchMedia,
    });

    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);

    act(() => {
      stub.setMatches(true);
    });
    expect(result.current).toBe(true);

    act(() => {
      stub.setMatches(false);
    });
    expect(result.current).toBe(false);
  });

  it('subscribes a single change listener and cleans up on unmount', () => {
    const stub = createMatchMediaStub(false);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: stub.matchMedia,
    });

    const { unmount } = renderHook(() => useIsMobile());
    expect(stub.addEventListener).toHaveBeenCalledTimes(1);
    expect(stub.addEventListener).toHaveBeenCalledWith(
      'change',
      expect.any(Function),
    );
    expect(stub.listenerCount()).toBe(1);

    unmount();
    expect(stub.removeEventListener).toHaveBeenCalledTimes(1);
    expect(stub.removeEventListener).toHaveBeenCalledWith(
      'change',
      expect.any(Function),
    );
    expect(stub.listenerCount()).toBe(0);
  });

  it('falls back to false when window.matchMedia is unavailable (SSR-safe guard)', () => {
    // Simulate an environment where matchMedia is missing — exercises both
    // the subscribe() and getSnapshot() guard branches in useIsMobile.
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: undefined,
    });

    const { result, unmount } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
    // No listener registered — cleanup must be a no-op (no throw).
    expect(() => {
      unmount();
    }).not.toThrow();
  });
});
