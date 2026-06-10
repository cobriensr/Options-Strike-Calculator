/**
 * useStickyUnion — absolute "never-vanish" accumulator for alert feeds.
 *
 * Verifies the core contract: items pin forever once seen (for the life
 * of a storageKey), upserts replace in place, a storageKey change resets
 * the union, and the union survives a page refresh via localStorage.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useStickyUnion } from '../hooks/useStickyUnion';

interface Alert {
  id: string;
  pct: number;
}

const keyFn = (a: Alert): string => a.id;

beforeEach(() => {
  localStorage.clear();
});

describe('useStickyUnion', () => {
  it('returns [] for empty items', () => {
    const { result } = renderHook(() =>
      useStickyUnion<Alert>([], { key: keyFn, storageKey: 'k' }),
    );
    expect(result.current).toEqual([]);
  });

  it('returns items that appear in the server response', () => {
    const items: Alert[] = [
      { id: 'a', pct: 10 },
      { id: 'b', pct: 20 },
    ];
    const { result } = renderHook(() =>
      useStickyUnion<Alert>(items, { key: keyFn, storageKey: 'k' }),
    );
    expect(result.current).toEqual(items);
  });

  it('PIN: keeps an item with its last-seen value after it is dropped from items', () => {
    const { result, rerender } = renderHook(
      ({ items }) =>
        useStickyUnion<Alert>(items, { key: keyFn, storageKey: 'k' }),
      {
        initialProps: {
          items: [
            { id: 'a', pct: 10 },
            { id: 'b', pct: 20 },
          ] as Alert[],
        },
      },
    );
    expect(result.current).toHaveLength(2);

    // Server drops 'b' in the next response.
    rerender({ items: [{ id: 'a', pct: 11 }] });

    const ids = result.current.map((r) => r.id).sort();
    expect(ids).toEqual(['a', 'b']);
    const b = result.current.find((r) => r.id === 'b');
    // 'b' retains its last-seen value.
    expect(b).toEqual({ id: 'b', pct: 20 });
  });

  it('UPDATE: replaces the stored value when an existing key reappears with changed fields', () => {
    const { result, rerender } = renderHook(
      ({ items }) =>
        useStickyUnion<Alert>(items, { key: keyFn, storageKey: 'k' }),
      { initialProps: { items: [{ id: 'a', pct: 10 }] as Alert[] } },
    );
    expect(result.current).toEqual([{ id: 'a', pct: 10 }]);

    rerender({ items: [{ id: 'a', pct: 99 }] });
    expect(result.current).toEqual([{ id: 'a', pct: 99 }]);
  });

  it('RESET on storageKey change: previously-pinned items from the old key are gone', () => {
    const { result, rerender } = renderHook(
      ({ items, storageKey }) =>
        useStickyUnion<Alert>(items, { key: keyFn, storageKey }),
      {
        initialProps: {
          items: [
            { id: 'a', pct: 10 },
            { id: 'b', pct: 20 },
          ] as Alert[],
          storageKey: 'day-1',
        },
      },
    );
    expect(result.current).toHaveLength(2);

    // New trading day → new storageKey, only 'c' present in items.
    rerender({ items: [{ id: 'c', pct: 30 }], storageKey: 'day-2' });
    expect(result.current).toEqual([{ id: 'c', pct: 30 }]);
  });

  it('PERSIST + HYDRATE: a fresh mount with the same storageKey restores previously-seen items', () => {
    const items: Alert[] = [
      { id: 'a', pct: 10 },
      { id: 'b', pct: 20 },
    ];
    const first = renderHook(() =>
      useStickyUnion<Alert>(items, { key: keyFn, storageKey: 'persist-key' }),
    );
    expect(first.result.current).toHaveLength(2);
    first.unmount();

    // Simulate a page refresh: brand-new hook instance, EMPTY server
    // response, same storageKey — the pinned items must hydrate from LS.
    const second = renderHook(() =>
      useStickyUnion<Alert>([], { key: keyFn, storageKey: 'persist-key' }),
    );
    const ids = second.result.current.map((r) => r.id).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('MALFORMED JSON: does not throw and starts empty', () => {
    localStorage.setItem('bad-key', 'not json');
    expect(() =>
      renderHook(() =>
        useStickyUnion<Alert>([], { key: keyFn, storageKey: 'bad-key' }),
      ),
    ).not.toThrow();

    const { result } = renderHook(() =>
      useStickyUnion<Alert>([], { key: keyFn, storageKey: 'bad-key-2' }),
    );
    expect(result.current).toEqual([]);
  });

  it('isolates keys: changing storageKey does not destroy the old key’s LS entry', () => {
    const { rerender } = renderHook(
      ({ items, storageKey }) =>
        useStickyUnion<Alert>(items, { key: keyFn, storageKey }),
      {
        initialProps: {
          items: [{ id: 'a', pct: 10 }] as Alert[],
          storageKey: 'iso-1',
        },
      },
    );
    rerender({ items: [{ id: 'b', pct: 20 }], storageKey: 'iso-2' });

    // Old key still holds its own data; remounting on it restores 'a'.
    const back = renderHook(() =>
      useStickyUnion<Alert>([], { key: keyFn, storageKey: 'iso-1' }),
    );
    expect(back.result.current).toEqual([{ id: 'a', pct: 10 }]);
  });

  // ── #9 null/empty-key guard ──────────────────────────────────────────
  describe('#9 null/empty-key guard', () => {
    it('skips an item whose key is empty string and does not collapse a valid sibling', () => {
      const items: Alert[] = [
        { id: 'a', pct: 10 },
        { id: '', pct: 20 },
      ];
      const { result } = renderHook(() =>
        useStickyUnion<Alert>(items, { key: keyFn, storageKey: 'k' }),
      );
      expect(result.current).toEqual([{ id: 'a', pct: 10 }]);
    });

    it('skips an item whose key contains an "undefined" segment', () => {
      const undefKey = (a: Alert): string => a.id;
      const items: Alert[] = [
        { id: 'AAPL|240C', pct: 10 },
        { id: 'AAPL|undefined', pct: 20 },
        { id: 'MSFT|null', pct: 30 },
      ];
      const { result } = renderHook(() =>
        useStickyUnion<Alert>(items, { key: undefKey, storageKey: 'k' }),
      );
      expect(result.current).toEqual([{ id: 'AAPL|240C', pct: 10 }]);
    });
  });

  // ── #7 stale-key sweep + size cap ────────────────────────────────────
  describe('#7 stale-key sweep', () => {
    it('removes stale same-feed keys on mount, keeping current + unrelated', () => {
      localStorage.setItem(
        'feed-union:lottery:2026-06-06',
        JSON.stringify([['stale', { id: 'stale', pct: 1 }]]),
      );
      localStorage.setItem(
        'feed-union:lottery:2026-06-07',
        JSON.stringify([['cur', { id: 'cur', pct: 2 }]]),
      );
      // Different feed prefix — must survive.
      localStorage.setItem(
        'feed-union:silent-boom:2026-06-06',
        JSON.stringify([['sb', { id: 'sb', pct: 3 }]]),
      );
      // Wholly unrelated key — must survive.
      localStorage.setItem('unrelated', 'keep-me');

      renderHook(() =>
        useStickyUnion<Alert>([], {
          key: keyFn,
          storageKey: 'feed-union:lottery:2026-06-07',
        }),
      );

      expect(localStorage.getItem('feed-union:lottery:2026-06-06')).toBeNull();
      expect(
        localStorage.getItem('feed-union:lottery:2026-06-07'),
      ).not.toBeNull();
      expect(
        localStorage.getItem('feed-union:silent-boom:2026-06-06'),
      ).not.toBeNull();
      expect(localStorage.getItem('unrelated')).toBe('keep-me');
    });

    // FIX 2: date-aware, suffix-proof sweep — same-day filter siblings coexist.
    it('removes a stale prior-day slot even when it carries a filter-signature suffix', () => {
      localStorage.setItem(
        'feed-union:lottery:2026-06-06',
        JSON.stringify([['stale', { id: 'stale', pct: 1 }]]),
      );
      localStorage.setItem(
        'feed-union:lottery:2026-06-06:sigX',
        JSON.stringify([['staleSig', { id: 'staleSig', pct: 1 }]]),
      );

      renderHook(() =>
        useStickyUnion<Alert>([], {
          key: keyFn,
          storageKey: 'feed-union:lottery:2026-06-07',
        }),
      );

      expect(localStorage.getItem('feed-union:lottery:2026-06-06')).toBeNull();
      expect(
        localStorage.getItem('feed-union:lottery:2026-06-06:sigX'),
      ).toBeNull();
    });

    it('PRESERVES a same-day different-filter sibling slot (never-vanish across filter switch)', () => {
      // Two filter settings active on the SAME day, each with its own union.
      localStorage.setItem(
        'feed-union:lottery:2026-06-07:sigB',
        JSON.stringify([['fromB', { id: 'fromB', pct: 9 }]]),
      );

      // Mount the union for filter sigA on the same day.
      renderHook(() =>
        useStickyUnion<Alert>([], {
          key: keyFn,
          storageKey: 'feed-union:lottery:2026-06-07:sigA',
        }),
      );

      // sigB's same-day slot MUST survive — switching A→B→A restores B's pins.
      expect(
        localStorage.getItem('feed-union:lottery:2026-06-07:sigB'),
      ).not.toBeNull();
    });

    it('keeps the reignited slot (distinct feed token) when sweeping the lottery feed', () => {
      localStorage.setItem(
        'feed-union:lottery-reignited:2026-06-06',
        JSON.stringify([['re', { id: 're', pct: 1 }]]),
      );
      renderHook(() =>
        useStickyUnion<Alert>([], {
          key: keyFn,
          storageKey: 'feed-union:lottery:2026-06-07',
        }),
      );
      // `lottery-reignited` is a different feed token from `lottery`.
      expect(
        localStorage.getItem('feed-union:lottery-reignited:2026-06-06'),
      ).not.toBeNull();
    });

    it('skips malformed feed-union keys with fewer than three segments', () => {
      localStorage.setItem('feed-union:lottery', 'truncated');
      localStorage.setItem('feed-union', 'truncated2');
      renderHook(() =>
        useStickyUnion<Alert>([], {
          key: keyFn,
          storageKey: 'feed-union:lottery:2026-06-07',
        }),
      );
      expect(localStorage.getItem('feed-union:lottery')).toBe('truncated');
      expect(localStorage.getItem('feed-union')).toBe('truncated2');
    });
  });

  // ── FIX 1: cap raised + safe (never-evict-visible, LRU-seen) eviction ──
  describe('#7 size cap', () => {
    it('caps the union at MAX_UNION_ENTRIES (8000) once pinned-but-absent rows overflow it', () => {
      const CAP = 8000;
      // First ingest pins CAP rows. They are all "seen" now.
      const first: Alert[] = Array.from({ length: CAP }, (_, i) => ({
        id: `id-${i}`,
        pct: i,
      }));
      const { result, rerender } = renderHook(
        ({ items }) =>
          useStickyUnion<Alert>(items, { key: keyFn, storageKey: 'cap' }),
        { initialProps: { items: first } },
      );
      expect(result.current).toHaveLength(CAP);

      // Next poll: the first batch is GONE from the payload (now pinned-but-
      // absent → evictable) and 100 brand-new rows arrive. Total would be
      // CAP + 100; eviction trims back to CAP by dropping the stalest absent.
      const second: Alert[] = Array.from({ length: 100 }, (_, i) => ({
        id: `new-${i}`,
        pct: i,
      }));
      rerender({ items: second });
      expect(result.current).toHaveLength(CAP);
      const ids = new Set(result.current.map((r) => r.id));
      // All 100 currently-reported rows survive (protected).
      expect(ids.has('new-0')).toBe(true);
      expect(ids.has('new-99')).toBe(true);
      // The stalest absent rows were the eviction victims.
      expect(ids.has('id-0')).toBe(false);
    });

    it('NEVER evicts a key present in the CURRENT items, even past the cap', () => {
      // The earliest-seen row 'keep' is fired at the open, then keeps being
      // reported by the server every poll. A storm later fills the union to
      // the cap with newer rows that then DROP OUT. The next poll re-reports
      // 'keep' alongside fresh rows, pushing past the cap. Old oldest-inserted
      // eviction would drop 'keep' (it is the oldest-inserted key); the safe
      // policy must NOT, because the server is still reporting it.
      const CAP = 8000;

      // Open: 'keep' fires first (oldest-inserted).
      const { result, rerender } = renderHook(
        ({ items }) =>
          useStickyUnion<Alert>(items, { key: keyFn, storageKey: 'cap-keep' }),
        {
          initialProps: { items: [{ id: 'keep', pct: 0 }] as Alert[] },
        },
      );

      // Storm: 'keep' (still reported) + (CAP - 1) brand-new rows → union = CAP.
      const storm: Alert[] = [
        { id: 'keep', pct: 0 },
        ...Array.from({ length: CAP - 1 }, (_, i) => ({
          id: `s-${i}`,
          pct: i,
        })),
      ];
      rerender({ items: storm });
      expect(result.current).toHaveLength(CAP);

      // Next poll: storm rows are GONE (pinned-but-absent → evictable), 'keep'
      // is STILL reported alongside 50 new rows. Union would be CAP + 50;
      // eviction trims 50 stale absent storm rows. 'keep' must survive.
      const next: Alert[] = [
        { id: 'keep', pct: 1 },
        ...Array.from({ length: 50 }, (_, i) => ({ id: `late-${i}`, pct: i })),
      ];
      rerender({ items: next });

      expect(result.current).toHaveLength(CAP);
      const ids = new Set(result.current.map((r) => r.id));
      // The currently-reported, oldest-inserted 'keep' row is NEVER evicted.
      expect(ids.has('keep')).toBe(true);
      // Stale absent storm rows were the eviction victims instead.
      expect(ids.has('s-0')).toBe(false);
    });

    it('evicts the least-recently-SEEN key first (not oldest-inserted)', () => {
      // Seed three rows, then re-touch the OLDEST-inserted ('a') so its
      // last-seen advances past the others. With a cap of 2 and a 4th new
      // row, the least-recently-SEEN absent row must be the eviction target,
      // not 'a' (which is oldest-inserted but most-recently-seen).
      const { result, rerender } = renderHook(
        ({ items }) =>
          useStickyUnion<Alert>(items, { key: keyFn, storageKey: 'lru' }),
        {
          initialProps: {
            items: [
              { id: 'a', pct: 1 },
              { id: 'b', pct: 2 },
              { id: 'c', pct: 3 },
            ] as Alert[],
          },
        },
      );
      // Re-touch 'a' (and only 'a') → its last-seen is now the newest; 'b'
      // and 'c' are now the stalest (and absent from items).
      rerender({ items: [{ id: 'a', pct: 99 }] });

      // The visible 'a' must survive; 'b'/'c' are pinned but stale.
      const ids = result.current.map((r) => r.id).sort();
      expect(ids).toEqual(['a', 'b', 'c']);
      // 'a' carries its refreshed value despite being oldest-inserted.
      expect(result.current.find((r) => r.id === 'a')?.pct).toBe(99);
    });

    it('keeps the persisted blob consistent with the in-memory map after eviction', () => {
      vi.useFakeTimers();
      try {
        const CAP = 8000;
        const first: Alert[] = Array.from({ length: CAP }, (_, i) => ({
          id: `id-${i}`,
          pct: i,
        }));
        const { result, rerender } = renderHook(
          ({ items }) =>
            useStickyUnion<Alert>(items, {
              key: keyFn,
              storageKey: 'cap-persist',
            }),
          { initialProps: { items: first } },
        );
        // Next poll drops the first batch (now evictable) and adds 5 new rows
        // → overflow of 5 trimmed from the stalest absent rows.
        const second: Alert[] = Array.from({ length: 5 }, (_, i) => ({
          id: `new-${i}`,
          pct: i,
        }));
        rerender({ items: second });
        act(() => {
          vi.advanceTimersByTime(1000);
        });
        const raw = localStorage.getItem('cap-persist');
        expect(raw).not.toBeNull();
        const parsed = JSON.parse(raw as string) as [string, Alert][];
        // Persisted pair count matches the capped in-memory snapshot exactly.
        expect(parsed).toHaveLength(CAP);
        expect(parsed).toHaveLength(result.current.length);
        const persistedIds = new Set(parsed.map(([k]) => k));
        const memoryIds = new Set(result.current.map((r) => r.id));
        expect(persistedIds).toEqual(memoryIds);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── #8 perf: dirty-check + debounced persist ─────────────────────────
  describe('#8 dirty-check + debounce', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('does not rewrite localStorage when an ingest is content-identical', () => {
      vi.useFakeTimers();
      const items: Alert[] = [{ id: 'a', pct: 10 }];
      const { rerender } = renderHook(
        ({ items }) =>
          useStickyUnion<Alert>(items, { key: keyFn, storageKey: 'dirty' }),
        { initialProps: { items } },
      );
      act(() => {
        vi.runAllTimers();
      });
      const setSpy = vi.spyOn(Storage.prototype, 'setItem');
      // Re-ingest the SAME content via a brand-new array reference.
      rerender({ items: [{ id: 'a', pct: 10 }] });
      act(() => {
        vi.runAllTimers();
      });
      expect(setSpy).not.toHaveBeenCalled();
      setSpy.mockRestore();
    });

    it('updates the returned array synchronously but debounces the LS write', () => {
      vi.useFakeTimers();
      const setSpy = vi.spyOn(Storage.prototype, 'setItem');
      const { result, rerender } = renderHook(
        ({ items }) =>
          useStickyUnion<Alert>(items, {
            key: keyFn,
            storageKey: 'debounce',
          }),
        { initialProps: { items: [{ id: 'a', pct: 1 }] as Alert[] } },
      );
      // Returned array reflects the ingest immediately.
      expect(result.current).toEqual([{ id: 'a', pct: 1 }]);
      const writesAfterFirst = setSpy.mock.calls.length;

      // Rapid successive ingests before the debounce window elapses.
      rerender({ items: [{ id: 'a', pct: 2 }] });
      rerender({ items: [{ id: 'b', pct: 3 }] });
      rerender({ items: [{ id: 'c', pct: 4 }] });
      // Snapshot is already current pre-flush.
      expect(result.current.map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
      // No durable write has landed for those rapid ingests yet.
      expect(setSpy.mock.calls.length).toBe(writesAfterFirst);

      act(() => {
        vi.advanceTimersByTime(1000);
      });
      // The coalesced trailing write lands exactly once.
      expect(setSpy.mock.calls.length).toBe(writesAfterFirst + 1);
      const lastWrite = setSpy.mock.calls.at(-1);
      expect(lastWrite?.[0]).toBe('debounce');
      expect(lastWrite?.[1]).toContain('"c"');
      setSpy.mockRestore();
    });

    it('flushes a pending debounced write on unmount', () => {
      vi.useFakeTimers();
      const { unmount } = renderHook(() =>
        useStickyUnion<Alert>([{ id: 'a', pct: 1 }], {
          key: keyFn,
          storageKey: 'flush',
        }),
      );
      const setSpy = vi.spyOn(Storage.prototype, 'setItem');
      unmount();
      // The pending write was flushed synchronously by cleanup.
      expect(setSpy).toHaveBeenCalledWith(
        'flush',
        expect.stringContaining('a'),
      );
      setSpy.mockRestore();
    });
  });

  // ── FIX 1: page-lifecycle flush (durable across hard refresh / bfcache) ──
  describe('page-lifecycle flush', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('flushes the pending debounced write synchronously on `pagehide`', () => {
      vi.useFakeTimers();
      // Ingest stages a debounced write but does NOT touch LS yet.
      renderHook(() =>
        useStickyUnion<Alert>([{ id: 'a', pct: 1 }], {
          key: keyFn,
          storageKey: 'lifecycle-pagehide',
        }),
      );
      // Pending only — debounce window has not elapsed.
      expect(localStorage.getItem('lifecycle-pagehide')).toBeNull();

      // Hard refresh / tab close fires pagehide BEFORE the timer would run.
      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });

      // The staged write must have landed synchronously.
      const raw = localStorage.getItem('lifecycle-pagehide');
      expect(raw).not.toBeNull();
      expect(raw).toContain('"a"');
    });

    it('flushes the pending debounced write when visibility becomes hidden', () => {
      vi.useFakeTimers();
      renderHook(() =>
        useStickyUnion<Alert>([{ id: 'a', pct: 1 }], {
          key: keyFn,
          storageKey: 'lifecycle-visibility',
        }),
      );
      expect(localStorage.getItem('lifecycle-visibility')).toBeNull();

      const visSpy = vi
        .spyOn(document, 'visibilityState', 'get')
        .mockReturnValue('hidden');
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      const raw = localStorage.getItem('lifecycle-visibility');
      expect(raw).not.toBeNull();
      expect(raw).toContain('"a"');
      visSpy.mockRestore();
    });

    it('does NOT flush on `visibilitychange` when the page is still visible', () => {
      vi.useFakeTimers();
      renderHook(() =>
        useStickyUnion<Alert>([{ id: 'a', pct: 1 }], {
          key: keyFn,
          storageKey: 'lifecycle-visible',
        }),
      );
      const visSpy = vi
        .spyOn(document, 'visibilityState', 'get')
        .mockReturnValue('visible');
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      // Still pending — a visible→visible transition must not write early.
      expect(localStorage.getItem('lifecycle-visible')).toBeNull();
      visSpy.mockRestore();
    });

    it('removes its lifecycle listeners on unmount', () => {
      const removeSpy = vi.spyOn(window, 'removeEventListener');
      const docRemoveSpy = vi.spyOn(document, 'removeEventListener');
      const { unmount } = renderHook(() =>
        useStickyUnion<Alert>([{ id: 'a', pct: 1 }], {
          key: keyFn,
          storageKey: 'lifecycle-cleanup',
        }),
      );
      unmount();
      expect(removeSpy).toHaveBeenCalledWith('pagehide', expect.any(Function));
      expect(docRemoveSpy).toHaveBeenCalledWith(
        'visibilitychange',
        expect.any(Function),
      );
      removeSpy.mockRestore();
      docRemoveSpy.mockRestore();
    });
  });

  // ── #6 tombstone escape hatch ────────────────────────────────────────
  describe('#6 tombstones', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('removes a tombstoned key from the union and from localStorage', () => {
      vi.useFakeTimers();
      const { result, rerender } = renderHook(
        ({ items, tombstones }) =>
          useStickyUnion<Alert>(items, {
            key: keyFn,
            storageKey: 'tomb',
            tombstones,
          }),
        {
          initialProps: {
            items: [
              { id: 'a', pct: 10 },
              { id: 'b', pct: 20 },
            ] as Alert[],
            tombstones: new Set<string>(),
          },
        },
      );
      expect(result.current).toHaveLength(2);

      // 'b' is genuinely retracted.
      rerender({
        items: [{ id: 'a', pct: 11 }],
        tombstones: new Set(['b']),
      });
      // Returned union drops 'b' synchronously.
      expect(result.current).toEqual([{ id: 'a', pct: 11 }]);
      // Flush the debounced persist, then assert the blob lost 'b' too.
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      const raw = localStorage.getItem('tomb');
      expect(raw).not.toBeNull();
      expect(raw).not.toContain('"b"');
    });

    it('does not ingest an item whose key is tombstoned', () => {
      const { result } = renderHook(() =>
        useStickyUnion<Alert>(
          [
            { id: 'a', pct: 10 },
            { id: 'b', pct: 20 },
          ],
          {
            key: keyFn,
            storageKey: 'tomb2',
            tombstones: new Set(['b']),
          },
        ),
      );
      expect(result.current).toEqual([{ id: 'a', pct: 10 }]);
    });

    it('pins normally when tombstones is absent', () => {
      const { result, rerender } = renderHook(
        ({ items }) =>
          useStickyUnion<Alert>(items, { key: keyFn, storageKey: 'tomb3' }),
        {
          initialProps: {
            items: [
              { id: 'a', pct: 10 },
              { id: 'b', pct: 20 },
            ] as Alert[],
          },
        },
      );
      rerender({ items: [{ id: 'a', pct: 11 }] });
      expect(result.current.map((r) => r.id).sort()).toEqual(['a', 'b']);
    });
  });

  // The hard-floor / cross-day guard: `retain(item) === false` drops a row at
  // BOTH hydrate and ingest, the never-vanish equivalent of a value-derived
  // floor (e.g. premium ≥ active floor, same trading day). Modeled here with
  // `pct >= floor` so the predicate is a pure function of the stored value.
  describe('retain guard', () => {
    const atLeast =
      (floor: number) =>
      (a: Alert): boolean =>
        a.pct >= floor;

    it('HYDRATE: drops persisted rows failing retain and persists the cleaned blob', () => {
      // Seed a slot (written while the floor was off) holding a sub-floor row.
      localStorage.setItem(
        'retain-hydrate',
        JSON.stringify([
          ['a', { id: 'a', pct: 10 }],
          ['b', { id: 'b', pct: 30 }],
        ]),
      );

      // Mount with the floor now at 20 and an EMPTY server response: only the
      // qualifying row ('b', pct 30) should hydrate; 'a' (pct 10) is dropped.
      const { result } = renderHook(() =>
        useStickyUnion<Alert>([], {
          key: keyFn,
          storageKey: 'retain-hydrate',
          retain: atLeast(20),
        }),
      );
      expect(result.current.map((r) => r.id)).toEqual(['b']);

      // The cleaned blob is persisted immediately so a reload can't re-read the
      // poisoned 'a' slot — the localStorage value no longer contains it.
      const persisted = JSON.parse(
        localStorage.getItem('retain-hydrate') ?? '[]',
      ) as Array<[string, Alert]>;
      expect(persisted.map(([k]) => k)).toEqual(['b']);
    });

    it('INGEST: never pins an incoming row failing retain', () => {
      const { result } = renderHook(() =>
        useStickyUnion<Alert>(
          [
            { id: 'a', pct: 10 }, // sub-floor — must be skipped
            { id: 'b', pct: 30 }, // qualifies
          ],
          { key: keyFn, storageKey: 'retain-ingest', retain: atLeast(20) },
        ),
      );
      expect(result.current.map((r) => r.id)).toEqual(['b']);
    });

    it('INGEST: purges an already-pinned row that newly fails retain (tightened floor)', () => {
      const { result, rerender } = renderHook(
        ({ items, floor }) =>
          useStickyUnion<Alert>(items, {
            key: keyFn,
            storageKey: 'retain-purge',
            retain: atLeast(floor),
          }),
        {
          initialProps: {
            items: [
              { id: 'a', pct: 15 },
              { id: 'b', pct: 30 },
            ] as Alert[],
            floor: 10,
          },
        },
      );
      // Floor 10: both pinned.
      expect(result.current.map((r) => r.id).sort()).toEqual(['a', 'b']);

      // Floor tightens to 20 and the server no longer reports 'a' (it isn't on
      // this page). The stale pin must be purged, not rendered indefinitely.
      rerender({ items: [{ id: 'b', pct: 30 }], floor: 20 });
      expect(result.current.map((r) => r.id)).toEqual(['b']);
    });

    it('preserves never-vanish for rows that pass retain across a transient omission', () => {
      const { result, rerender } = renderHook(
        ({ items }) =>
          useStickyUnion<Alert>(items, {
            key: keyFn,
            storageKey: 'retain-pin',
            retain: atLeast(20),
          }),
        {
          initialProps: {
            items: [
              { id: 'a', pct: 25 },
              { id: 'b', pct: 30 },
            ] as Alert[],
          },
        },
      );
      expect(result.current.map((r) => r.id).sort()).toEqual(['a', 'b']);

      // Server transiently drops 'b' (still qualifies) — it must stay pinned.
      rerender({ items: [{ id: 'a', pct: 25 }] });
      expect(result.current.map((r) => r.id).sort()).toEqual(['a', 'b']);
    });

    it('tombstones still take precedence (deletion wins over a passing retain)', () => {
      const { result, rerender } = renderHook(
        ({ items, tombstones }) =>
          useStickyUnion<Alert>(items, {
            key: keyFn,
            storageKey: 'retain-tomb',
            retain: atLeast(20),
            tombstones,
          }),
        {
          initialProps: {
            items: [
              { id: 'a', pct: 25 },
              { id: 'b', pct: 30 },
            ] as Alert[],
            tombstones: undefined as ReadonlySet<string> | undefined,
          },
        },
      );
      expect(result.current.map((r) => r.id).sort()).toEqual(['a', 'b']);

      // 'b' passes retain (pct 30 ≥ 20) but is tombstoned → still removed.
      rerender({
        items: [
          { id: 'a', pct: 25 },
          { id: 'b', pct: 30 },
        ],
        tombstones: new Set(['b']),
      });
      expect(result.current.map((r) => r.id)).toEqual(['a']);
    });
  });
});
