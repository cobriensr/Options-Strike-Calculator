import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePersistedState } from '../usePersistedState';

const KEY = 'usePersistedState.test';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('usePersistedState', () => {
  describe('initial read', () => {
    it('returns defaultValue when key is missing', () => {
      const { result } = renderHook(() => usePersistedState(KEY, 42));
      expect(result.current[0]).toBe(42);
    });

    it('reads JSON-encoded value when present', () => {
      window.localStorage.setItem(KEY, JSON.stringify({ a: 1 }));
      const { result } = renderHook(() => usePersistedState(KEY, { a: 0 }));
      expect(result.current[0]).toEqual({ a: 1 });
    });

    it('falls back to defaultValue on corrupt JSON', () => {
      window.localStorage.setItem(KEY, '{ not valid json');
      const { result } = renderHook(() => usePersistedState(KEY, 'fallback'));
      expect(result.current[0]).toBe('fallback');
    });

    it('honors a custom parse function for bespoke encodings', () => {
      window.localStorage.setItem(KEY, '1');
      const { result } = renderHook(() =>
        usePersistedState(KEY, false, {
          parse: (raw) => raw === '1',
          serialize: (v) => (v ? '1' : '0'),
        }),
      );
      expect(result.current[0]).toBe(true);
    });

    it('falls back when custom parse returns undefined', () => {
      window.localStorage.setItem(KEY, 'unknown-enum');
      type Mode = 'a' | 'b';
      const { result } = renderHook(() =>
        usePersistedState<Mode>(KEY, 'a', {
          parse: (raw): Mode | undefined =>
            raw === 'a' || raw === 'b' ? raw : undefined,
        }),
      );
      expect(result.current[0]).toBe('a');
    });

    it('falls back when custom parse throws', () => {
      window.localStorage.setItem(KEY, 'anything');
      const { result } = renderHook(() =>
        usePersistedState<number>(KEY, 7, {
          parse: () => {
            throw new Error('boom');
          },
        }),
      );
      expect(result.current[0]).toBe(7);
    });
  });

  describe('write effect', () => {
    it('writes JSON on every value change', () => {
      const { result } = renderHook(() => usePersistedState(KEY, 0));
      act(() => result.current[1](5));
      expect(window.localStorage.getItem(KEY)).toBe('5');
    });

    it('uses custom serialize when provided', () => {
      const { result } = renderHook(() =>
        usePersistedState(KEY, false, {
          parse: (raw) => raw === '1',
          serialize: (v) => (v ? '1' : '0'),
        }),
      );
      act(() => result.current[1](true));
      expect(window.localStorage.getItem(KEY)).toBe('1');
    });

    it('removes the key when serialize returns null', () => {
      window.localStorage.setItem(KEY, 'existing');
      const { result } = renderHook(() =>
        usePersistedState<string | null>(KEY, 'existing', {
          serialize: (v) => v,
        }),
      );
      act(() => result.current[1](null));
      expect(window.localStorage.getItem(KEY)).toBeNull();
    });

    it('swallows quota / disabled-storage errors during writes', () => {
      const setItemSpy = vi
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementation(() => {
          throw new Error('quota exceeded');
        });
      const { result } = renderHook(() => usePersistedState(KEY, 0));
      expect(() => act(() => result.current[1](1))).not.toThrow();
      expect(setItemSpy).toHaveBeenCalled();
    });
  });

  describe('lazy defaultValue', () => {
    it('accepts a () => T thunk and only runs it on first render', () => {
      const factory = vi.fn(() => 'initial');
      const { rerender } = renderHook(() =>
        usePersistedState<string>(KEY, factory),
      );
      expect(factory).toHaveBeenCalledTimes(1);
      rerender();
      expect(factory).toHaveBeenCalledTimes(1);
    });

    it('lets the lazy default read another LS key (legacy-migration pattern)', () => {
      // Simulates the LotteryFinder one-time migration from a legacy
      // boolean key — `factory` reads localStorage, but only when the
      // main key is missing.
      window.localStorage.setItem('legacy.flag', '1');
      const { result } = renderHook(() =>
        usePersistedState<'tier1' | 'all'>(KEY, () =>
          window.localStorage.getItem('legacy.flag') === '1' ? 'tier1' : 'all',
        ),
      );
      expect(result.current[0]).toBe('tier1');
    });

    it('skips the lazy default when the main key has a parseable value', () => {
      window.localStorage.setItem(KEY, JSON.stringify('persisted'));
      const factory = vi.fn(() => 'fallback');
      const { result } = renderHook(() =>
        usePersistedState<string>(KEY, factory),
      );
      expect(result.current[0]).toBe('persisted');
      expect(factory).not.toHaveBeenCalled();
    });
  });

  describe('round trip across remount', () => {
    it('preserves value through unmount + remount', () => {
      const first = renderHook(() => usePersistedState(KEY, 0));
      act(() => first.result.current[1](99));
      first.unmount();

      const second = renderHook(() => usePersistedState(KEY, 0));
      expect(second.result.current[0]).toBe(99);
    });

    it('honors custom parse on remount with bespoke encoding', () => {
      const opts = {
        parse: (raw: string) => raw === '1',
        serialize: (v: boolean) => (v ? '1' : '0'),
      };
      const first = renderHook(() => usePersistedState(KEY, false, opts));
      act(() => first.result.current[1](true));
      expect(window.localStorage.getItem(KEY)).toBe('1');
      first.unmount();

      const second = renderHook(() => usePersistedState(KEY, false, opts));
      expect(second.result.current[0]).toBe(true);
    });
  });

  describe('setter contract', () => {
    it('supports the updater form like useState', () => {
      const { result } = renderHook(() => usePersistedState(KEY, 10));
      act(() => result.current[1]((prev) => prev + 5));
      expect(result.current[0]).toBe(15);
      expect(window.localStorage.getItem(KEY)).toBe('15');
    });

    it('returns a stable setter identity across renders', () => {
      const { result, rerender } = renderHook(() =>
        usePersistedState(KEY, 'a'),
      );
      const firstSetter = result.current[1];
      rerender();
      expect(result.current[1]).toBe(firstSetter);
    });
  });
});
