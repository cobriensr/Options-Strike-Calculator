import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearLicensedClientCaches } from '../lib/licensed-client-caches';

/**
 * The browser keys that hold Unusual Whales or GEXBot data, as they sit in a
 * visitor's storage today. Literals on purpose: the util and the writing hooks
 * take their names from one leaf module (`licensed-cache-keys.ts`), so renaming
 * a key there would move the util and the writer together and leave the old
 * key in every browser that already has it. This list fails on that rename
 * instead.
 */
const LICENSED_KEYS = [
  'openingFlowSignal.lastGood',
  'openingFlowSignal.lastGood:2026-11-20',
  'openingFlowSignal.lastGood:2026-05-13',
  'regime0dte:lastgood',
  'feed-union:lottery:2026-11-20:sig-a',
  'feed-union:lottery:2026-11-20:sig-b',
  'feed-union:lottery-reignited:2026-11-20:sig-a',
  'feed-union:silent-boom:2026-11-20:sig-a',
  // A prior day's slot, which the writers sweep only when a feed mounts.
  'feed-union:silent-boom:2026-11-19:sig-a',
] as const;

/** Preferences and flags: not licensed data, so the purge must not touch them. */
const KEPT_ENTRIES: Record<string, string> = {
  'lottery.sortMode': '"chronological"',
  'lottery.convictionFloor': '60',
  'silentBoom.minPremiumK': '50',
  'lottery-ticker-expanded': '["SPY","QQQ"]',
  'sc-panel-prefs-v1': '{"hidden":["sec-gex-target"],"order":[]}',
  'strike-calc:vix-data': '{"2026-11-20":{"o":16.1,"c":16.4}}',
  'strike-calc:vix-source': 'file',
  darkMode: 'true',
  // `feed-union` somewhere in the key, but not as its prefix.
  'old-feed-union:lottery:2026-11-20:sig-a': 'not a feed slot',
  'prefs.feed-union.collapsed': '1',
  // Sibling names of the opening-flow and regime slots.
  'openingFlowSignal.lastGoodNote': 'not the cache',
  'regime0dte:lastgood-note': 'not the cache',
  'regime0dte:settings': '{}',
};

function seed(keys: readonly string[]): void {
  for (const key of keys) localStorage.setItem(key, `payload for ${key}`);
}

function seedKept(): void {
  for (const [key, value] of Object.entries(KEPT_ENTRIES)) {
    localStorage.setItem(key, value);
  }
}

/** Every entry in storage, key to value. */
function entries(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key != null) out[key] = localStorage.getItem(key) ?? '';
  }
  return out;
}

describe('clearLicensedClientCaches', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it.each(LICENSED_KEYS)('removes %s', (key) => {
    seed(LICENSED_KEYS);
    seedKept();

    clearLicensedClientCaches();

    expect(localStorage.getItem(key)).toBeNull();
  });

  it('leaves every other key byte-identical', () => {
    seed(LICENSED_KEYS);
    seedKept();

    clearLicensedClientCaches();

    expect(entries()).toEqual(KEPT_ENTRIES);
  });

  it('does nothing to an empty storage, or when called twice', () => {
    expect(() => clearLicensedClientCaches()).not.toThrow();
    expect(entries()).toEqual({});

    seed(LICENSED_KEYS);
    seedKept();
    clearLicensedClientCaches();
    expect(() => clearLicensedClientCaches()).not.toThrow();
    expect(entries()).toEqual(KEPT_ENTRIES);
  });

  it('removes a licensed key written after an earlier call', () => {
    // No latch: a later call is a real purge, not a once-only one.
    clearLicensedClientCaches();
    seed(['regime0dte:lastgood']);

    clearLicensedClientCaches();

    expect(localStorage.getItem('regime0dte:lastgood')).toBeNull();
  });

  describe('when storage misbehaves', () => {
    // Whichever key refuses to go, wherever it falls in the order the util
    // removes them, every other licensed key is still removed.
    it.each(LICENSED_KEYS)(
      'still clears the other keys when removeItem throws for %s',
      (stuck) => {
        seed(LICENSED_KEYS);
        seedKept();
        const original = Storage.prototype.removeItem;
        vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (
          this: Storage,
          key: string,
        ) {
          if (key === stuck) throw new Error('storage denied');
          original.call(this, key);
        });

        expect(() => clearLicensedClientCaches()).not.toThrow();

        // Only the key whose removal threw is left, plus the preferences.
        expect(entries()).toEqual({
          ...KEPT_ENTRIES,
          [stuck]: `payload for ${stuck}`,
        });
      },
    );

    it('still clears the two single-slot keys when the key scan throws', () => {
      seed(LICENSED_KEYS);
      vi.spyOn(Storage.prototype, 'key').mockImplementation(() => {
        throw new Error('storage denied');
      });

      expect(() => clearLicensedClientCaches()).not.toThrow();

      // The dated and feed slots cannot be found without the scan.
      expect(localStorage.getItem('openingFlowSignal.lastGood')).toBeNull();
      expect(localStorage.getItem('regime0dte:lastgood')).toBeNull();
    });

    it('does not throw when the browser has no localStorage', () => {
      vi.stubGlobal('localStorage', undefined);

      expect(() => clearLicensedClientCaches()).not.toThrow();
    });

    it('does not throw when the browser denies access to localStorage', () => {
      const descriptor = Object.getOwnPropertyDescriptor(
        globalThis,
        'localStorage',
      );
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('denied', 'SecurityError');
        },
      });
      try {
        expect(() => clearLicensedClientCaches()).not.toThrow();
      } finally {
        if (descriptor) {
          Object.defineProperty(globalThis, 'localStorage', descriptor);
        }
      }
    });
  });
});
