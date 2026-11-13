import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getLiveSaveOverride,
  isLiveSaveDevice,
  isTouchFirstDevice,
  setLiveSaveOverride,
  subscribeLiveSaveDevice,
} from '../lib/live-save-device';

const STORAGE_KEY = 'sc-live-save-device';
const TOUCH_FIRST_QUERY = '(hover: none) and (pointer: coarse)';

/**
 * Stubs `matchMedia` so only the touch-first query can match. A wrong query
 * string therefore reads as a desktop, and the tests below fail on it.
 */
function stubTouchFirst(touchFirst: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: touchFirst && query === TOUCH_FIRST_QUERY,
    })),
  );
}

function makeStorageThrow(
  method: 'getItem' | 'setItem' | 'removeItem',
  message = 'storage denied',
): void {
  vi.spyOn(Storage.prototype, method).mockImplementation(() => {
    throw new Error(message);
  });
}

describe('live-save-device', () => {
  beforeEach(() => {
    localStorage.clear();
    stubTouchFirst(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  describe('isTouchFirstDevice', () => {
    it('is true when the primary pointer is coarse and cannot hover', () => {
      stubTouchFirst(true);
      expect(isTouchFirstDevice()).toBe(true);
    });

    it('is false on a computer, touchscreen laptops included', () => {
      // A touchscreen laptop's primary pointer is fine and can hover, so the
      // query does not match.
      stubTouchFirst(false);
      expect(isTouchFirstDevice()).toBe(false);
    });

    it('asks the browser about the hover and pointer media features', () => {
      stubTouchFirst(true);
      isTouchFirstDevice();
      expect(window.matchMedia).toHaveBeenCalledWith(TOUCH_FIRST_QUERY);
    });

    it('reads as a computer when the browser has no matchMedia', () => {
      vi.stubGlobal('matchMedia', undefined);
      expect(isTouchFirstDevice()).toBe(false);
    });
  });

  describe('getLiveSaveOverride', () => {
    it('is null when nothing is stored', () => {
      expect(getLiveSaveOverride()).toBeNull();
    });

    it.each(['on', 'off'] as const)('reads a stored %s', (value) => {
      localStorage.setItem(STORAGE_KEY, value);
      expect(getLiveSaveOverride()).toBe(value);
    });

    it.each(['maybe', '', 'ON', 'true', '1', ' on'])(
      'reads the unknown stored value %j as no override',
      (value) => {
        localStorage.setItem(STORAGE_KEY, value);
        expect(getLiveSaveOverride()).toBeNull();
      },
    );

    it('reads as no override when storage throws', () => {
      localStorage.setItem(STORAGE_KEY, 'on');
      makeStorageThrow('getItem');
      expect(getLiveSaveOverride()).toBeNull();
    });
  });

  describe('setLiveSaveOverride', () => {
    it.each(['on', 'off'] as const)(
      'stores %s under the sc-live-save-device key',
      (value) => {
        setLiveSaveOverride(value);
        expect(localStorage.getItem(STORAGE_KEY)).toBe(value);
        expect(getLiveSaveOverride()).toBe(value);
      },
    );

    it('clears the key when given null', () => {
      localStorage.setItem(STORAGE_KEY, 'off');
      setLiveSaveOverride(null);
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(getLiveSaveOverride()).toBeNull();
    });

    it('does not throw when storage refuses the write', () => {
      makeStorageThrow('setItem');
      expect(() => setLiveSaveOverride('on')).not.toThrow();
    });

    it('does not throw when storage refuses the clear', () => {
      makeStorageThrow('removeItem');
      expect(() => setLiveSaveOverride(null)).not.toThrow();
    });
  });

  describe('isLiveSaveDevice', () => {
    it.each([
      { touchFirst: true, stored: null, expected: false },
      { touchFirst: false, stored: null, expected: true },
      { touchFirst: true, stored: 'on', expected: true },
      { touchFirst: true, stored: 'off', expected: false },
      { touchFirst: false, stored: 'on', expected: true },
      { touchFirst: false, stored: 'off', expected: false },
      { touchFirst: true, stored: 'garbage', expected: false },
      { touchFirst: false, stored: 'garbage', expected: true },
    ])(
      'touch-first $touchFirst, stored $stored: saves is $expected',
      ({ touchFirst, stored, expected }) => {
        stubTouchFirst(touchFirst);
        if (stored !== null) localStorage.setItem(STORAGE_KEY, stored);
        expect(isLiveSaveDevice()).toBe(expected);
      },
    );

    it.each([
      { touchFirst: true, expected: false },
      { touchFirst: false, expected: true },
    ])(
      'falls back to the device default when storage throws (touch-first $touchFirst)',
      ({ touchFirst, expected }) => {
        stubTouchFirst(touchFirst);
        makeStorageThrow('getItem');
        expect(isLiveSaveDevice()).toBe(expected);
      },
    );

    it('follows a change made after the first read', () => {
      stubTouchFirst(true);
      expect(isLiveSaveDevice()).toBe(false);
      setLiveSaveOverride('on');
      expect(isLiveSaveDevice()).toBe(true);
      setLiveSaveOverride(null);
      expect(isLiveSaveDevice()).toBe(false);
    });
  });

  describe('subscribeLiveSaveDevice', () => {
    it('notifies on every set, including a clear', () => {
      const cb = vi.fn();
      const unsubscribe = subscribeLiveSaveDevice(cb);
      setLiveSaveOverride('on');
      setLiveSaveOverride('off');
      setLiveSaveOverride(null);
      expect(cb).toHaveBeenCalledTimes(3);
      unsubscribe();
    });

    it('notifies after the new value is readable', () => {
      const seen: boolean[] = [];
      const unsubscribe = subscribeLiveSaveDevice(() => {
        seen.push(isLiveSaveDevice());
      });
      stubTouchFirst(true);
      setLiveSaveOverride('on');
      setLiveSaveOverride(null);
      expect(seen).toEqual([true, false]);
      unsubscribe();
    });

    it('stops notifying after unsubscribe', () => {
      const cb = vi.fn();
      const unsubscribe = subscribeLiveSaveDevice(cb);
      unsubscribe();
      setLiveSaveOverride('on');
      expect(cb).not.toHaveBeenCalled();
    });

    it('unsubscribing one callback leaves the others subscribed', () => {
      const first = vi.fn();
      const second = vi.fn();
      const unsubscribeFirst = subscribeLiveSaveDevice(first);
      const unsubscribeSecond = subscribeLiveSaveDevice(second);
      unsubscribeFirst();
      setLiveSaveOverride('off');
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
      unsubscribeSecond();
    });

    it('unsubscribing twice is harmless', () => {
      const cb = vi.fn();
      const other = vi.fn();
      const unsubscribe = subscribeLiveSaveDevice(cb);
      const unsubscribeOther = subscribeLiveSaveDevice(other);
      unsubscribe();
      expect(() => unsubscribe()).not.toThrow();
      setLiveSaveOverride('on');
      expect(other).toHaveBeenCalledTimes(1);
      unsubscribeOther();
    });
  });
});
