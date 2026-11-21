/**
 * useStickyUnion — absolute "never-vanish" accumulator for alert feeds.
 *
 * Verifies the core contract: items pin forever once seen (for the life
 * of a storageKey), upserts replace in place, a storageKey change resets
 * the union, and the union survives a page refresh via localStorage.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { StrictMode, createElement, useEffect, type ReactNode } from 'react';
import { renderHook, act } from '@testing-library/react';
import { useETToday } from '../hooks/useETToday';
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

  // ── localStorage WRITE degrade (quota / private mode) ────────────────
  describe('persist write degrade (setItem throws)', () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('DEGRADE-NOT-CRASH: a throwing setItem (quota/private-mode) does not throw and the union still returns rows', () => {
      vi.useFakeTimers();
      // Simulate a full quota / Safari private mode: every durable write
      // rejects. The hook's persistUnion try/catch must swallow it and keep
      // the in-memory union authoritative.
      const setSpy = vi
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementation(() => {
          throw new DOMException('QuotaExceededError');
        });

      const items: Alert[] = [
        { id: 'a', pct: 10 },
        { id: 'b', pct: 20 },
      ];
      let result: { current: Alert[] } | undefined;
      // Mount + ingest must not throw despite the failing write.
      expect(() => {
        result = renderHook(() =>
          useStickyUnion<Alert>(items, {
            key: keyFn,
            storageKey: 'quota-throw',
          }),
        ).result;
      }).not.toThrow();

      // Snapshot still reflects the ingest (in-memory union is intact).
      expect(result!.current.map((r) => r.id).sort()).toEqual(['a', 'b']);

      // Force the debounced write to fire — it throws inside persistUnion but
      // is swallowed; advancing the timer must not surface the throw.
      expect(() => {
        act(() => {
          vi.advanceTimersByTime(1000);
        });
      }).not.toThrow();

      // The union is still usable after the failed persist.
      expect(result!.current.map((r) => r.id).sort()).toEqual(['a', 'b']);
      setSpy.mockRestore();
    });

    it('keeps pinning new rows across rerenders even when every write throws', () => {
      vi.useFakeTimers();
      const setSpy = vi
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementation(() => {
          throw new DOMException('QuotaExceededError');
        });

      const { result, rerender } = renderHook(
        ({ items }) =>
          useStickyUnion<Alert>(items, {
            key: keyFn,
            storageKey: 'quota-throw-2',
          }),
        { initialProps: { items: [{ id: 'a', pct: 1 }] as Alert[] } },
      );
      expect(result.current.map((r) => r.id)).toEqual(['a']);

      // A later poll adds 'b' and drops 'a' from the payload — never-vanish
      // must still pin 'a' in memory even though the write keeps failing.
      expect(() => {
        rerender({ items: [{ id: 'b', pct: 2 }] });
        act(() => {
          vi.advanceTimersByTime(1000);
        });
      }).not.toThrow();
      expect(result.current.map((r) => r.id).sort()).toEqual(['a', 'b']);
      setSpy.mockRestore();
    });
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
    // The sweep is relative to the live day (the shared ET clock), so these
    // run on 2026-06-07, the date their `current` keys carry.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-06-07T17:00:00Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

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
      // One debounce window, not runAllTimers: the hook subscribes to the ET
      // clock (useETToday), whose timer re-arms itself, so "all timers" never
      // ends.
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      const setSpy = vi.spyOn(Storage.prototype, 'setItem');
      // Re-ingest the SAME content via a brand-new array reference.
      rerender({ items: [{ id: 'a', pct: 10 }] });
      act(() => {
        vi.advanceTimersByTime(1_000);
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

// ============================================================
// Same-commit rehydrate (docs/superpowers/specs/panel-date-rollover-2026-11-14.md,
// Phase 9)
//
// The panels key the union by date (`feed-union:<feed>:<date>:<sig>`), so a
// date change, or the roll at ET midnight, changes `storageKey`. The hook used
// to reset and rehydrate in an effect on that change, so the commit that
// carried the new key still returned the old key's snapshot: yesterday's rows
// drew under the new date for one commit. These tests record the value
// returned by every COMMITTED render (an effect with no deps runs after each),
// not `result.current`, which only shows the last one.
// ============================================================

describe('useStickyUnion: same-commit rehydrate', () => {
  interface Props {
    items: Alert[];
    storageKey: string;
    retain?: (a: Alert) => boolean;
  }

  /** Every committed render's key and the ids it returned, in order. */
  function renderRecorded(initialProps: Props, strict = false) {
    const committed: { storageKey: string; ids: string[] }[] = [];
    const wrapper = strict
      ? ({ children }: { children: ReactNode }) =>
          createElement(StrictMode, null, children)
      : undefined;
    const hook = renderHook(
      ({ items, storageKey, retain }: Props) => {
        const rows = useStickyUnion<Alert>(items, {
          key: keyFn,
          storageKey,
          ...(retain !== undefined && { retain }),
        });
        useEffect(() => {
          committed.push({ storageKey, ids: rows.map((r) => r.id) });
        });
        return rows;
      },
      { initialProps, ...(wrapper !== undefined && { wrapper }) },
    );
    return { ...hook, committed };
  }

  const seed = (slot: string, rows: Alert[]): void => {
    localStorage.setItem(slot, JSON.stringify(rows.map((r) => [r.id, r])));
  };
  const idsUnder = (
    committed: { storageKey: string; ids: string[] }[],
    slot: string,
  ) => committed.filter((c) => c.storageKey === slot).map((c) => c.ids);

  it('never commits the old key’s rows under the new key', () => {
    seed('slot-B', [{ id: 'b1', pct: 5 }]);
    const { committed, rerender } = renderRecorded({
      items: [
        { id: 'a1', pct: 1 },
        { id: 'a2', pct: 2 },
      ],
      storageKey: 'slot-A',
    });
    expect(idsUnder(committed, 'slot-A').at(-1)).toEqual(['a1', 'a2']);

    // The panel passes [] when it is not on the live view (a past date).
    rerender({ items: [], storageKey: 'slot-B' });

    const underB = idsUnder(committed, 'slot-B');
    expect(underB.length).toBeGreaterThan(0);
    // Every commit under B returns B's own stored row, the first one included.
    expect(underB.every((ids) => ids.join() === 'b1')).toBe(true);
  });

  it('the commit that carries a new key holds that key’s stored rows, and ingest then adds to them', () => {
    seed('day-2', [{ id: 'b1', pct: 5 }]);
    const { committed, result, rerender } = renderRecorded({
      items: [{ id: 'a1', pct: 1 }],
      storageKey: 'day-1',
    });

    rerender({ items: [{ id: 'b2', pct: 6 }], storageKey: 'day-2' });

    // Ingest sees the hydrated union: b1 from storage, b2 from the payload.
    expect(result.current.map((r) => r.id)).toEqual(['b1', 'b2']);
    for (const ids of idsUnder(committed, 'day-2')) {
      expect(ids).not.toContain('a1');
      expect(ids).toContain('b1');
    }
  });

  it('a key with nothing stored commits an empty list at once, not the old rows', () => {
    const { committed, rerender } = renderRecorded({
      items: [{ id: 'a1', pct: 1 }],
      storageKey: 'day-1',
    });

    rerender({ items: [], storageKey: 'day-2' });

    // Every commit under the new key is empty, the first one included. (A
    // second, identical commit follows: the effect drops the old key's rows
    // from state.)
    const underDay2 = idsUnder(committed, 'day-2');
    expect(underDay2.length).toBeGreaterThan(0);
    expect(underDay2.every((ids) => ids.length === 0)).toBe(true);
  });

  it('the first committed render of a mount already holds the stored rows', () => {
    seed('mount-slot', [
      { id: 'a', pct: 1 },
      { id: 'b', pct: 2 },
    ]);

    const { committed } = renderRecorded({
      items: [],
      storageKey: 'mount-slot',
    });

    expect(committed[0]?.ids).toEqual(['a', 'b']);
  });

  it('returning to a key restores its rows, not the rows held when it was left', () => {
    seed('day-1', [{ id: 'a1', pct: 1 }]);
    const { committed, rerender } = renderRecorded({
      items: [{ id: 'a2', pct: 2 }],
      storageKey: 'day-1',
    });
    // a2 was ingested under day-1; leave and come back, with a new floor that
    // rejects it. The hydrate drops it, so the return must not show it.
    rerender({ items: [], storageKey: 'day-2' });
    rerender({
      items: [],
      storageKey: 'day-1',
      retain: (a) => a.pct < 2,
    });

    expect(idsUnder(committed, 'day-1').at(-1)).toEqual(['a1']);
  });

  it('applies retain to the rows of the new key in the same commit and heals the slot after it', () => {
    seed('floor-slot', [
      { id: 'low', pct: 5 },
      { id: 'high', pct: 50 },
    ]);
    const { committed, rerender } = renderRecorded({
      items: [],
      storageKey: 'other-slot',
    });

    rerender({
      items: [],
      storageKey: 'floor-slot',
      retain: (a) => a.pct >= 20,
    });

    for (const ids of idsUnder(committed, 'floor-slot')) {
      expect(ids).toEqual(['high']);
    }
    const healed = JSON.parse(
      localStorage.getItem('floor-slot') ?? '[]',
    ) as Array<[string, Alert]>;
    expect(healed.map(([k]) => k)).toEqual(['high']);
  });

  it('flushes the old slot’s pending write when the key changes', () => {
    vi.useFakeTimers();
    try {
      const { rerender } = renderRecorded({
        items: [{ id: 'a1', pct: 1 }],
        storageKey: 'day-1',
      });
      expect(localStorage.getItem('day-1')).toBeNull(); // debounced, not yet written

      rerender({ items: [], storageKey: 'day-2' });

      const flushed = JSON.parse(
        localStorage.getItem('day-1') ?? '[]',
      ) as Array<[string, Alert]>;
      expect(flushed.map(([k]) => k)).toEqual(['a1']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('under StrictMode a key change commits only the new key’s rows and the render itself writes nothing', () => {
    vi.useFakeTimers();
    try {
      seed('slot-B', [{ id: 'b1', pct: 5 }]);
      const { committed, rerender } = renderRecorded(
        { items: [{ id: 'a1', pct: 1 }], storageKey: 'slot-A' },
        true,
      );
      // Let A's debounced write land, then count writes across the key change.
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      const setItem = vi.spyOn(Storage.prototype, 'setItem');

      rerender({ items: [], storageKey: 'slot-B' });

      expect(setItem).not.toHaveBeenCalled();
      setItem.mockRestore();
      const underB = idsUnder(committed, 'slot-B');
      expect(underB.length).toBeGreaterThan(0);
      expect(underB.every((ids) => ids.join() === 'b1')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not loop: an `items` array that is a fresh reference every render commits a bounded number of times', () => {
    seed('loop-slot', [{ id: 'a', pct: 1 }]);
    let commits = 0;
    renderHook(() => {
      // A new `[]` on every render, as the panels pass while disengaged.
      const rows = useStickyUnion<Alert>([], {
        key: keyFn,
        storageKey: 'loop-slot',
      });
      useEffect(() => {
        commits += 1;
      });
      return rows;
    });
    expect(commits).toBeLessThan(5);
  });
});

// ============================================================
// Sweep relative to the live day (same spec, Phase 9)
//
// The panels build `feed-union:<feed>:<date>:<sig>` from the date being VIEWED.
// The sweep deletes the same feed's slots whose date is not the live day, the
// shared ET clock their `date` follows (`useFollowedDate` reads `useETToday`).
// It used to run once, on mount, relative to the mount key's date: a union from
// yesterday lingered after the midnight roll, and a panel mounted on a past
// date swept today's slots. It must never run relative to the key's date, or a
// detour to yesterday deletes today's union, which the panels promise survives
// it. Today here is 2026-06-07 (ET); the roll case crosses into 2026-06-08.
// ============================================================

describe('useStickyUnion: sweep relative to the live day', () => {
  const TODAY = '2026-06-07';
  const NEXT = '2026-06-08';
  const PAST = '2026-06-03';
  const slot = (feed: string, date: string, sig?: string): string =>
    sig === undefined
      ? `feed-union:${feed}:${date}`
      : `feed-union:${feed}:${date}:${sig}`;
  const put = (k: string): void =>
    localStorage.setItem(k, JSON.stringify([['x', { id: 'x', pct: 1 }]]));
  const has = (k: string): boolean => localStorage.getItem(k) !== null;

  /** Slots that no sweep may touch, whatever the date. */
  const bystanders = [
    slot('silent-boom', PAST, 'sigA'),
    slot('lottery-reignited', TODAY, 'sigA'),
    'feed-union:lottery',
    'feed-union',
    'unrelated',
  ];

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A panel's hook: key = feed + the date it is on + a filter signature. */
  function renderFeed(date: string, items: Alert[] = []) {
    return renderHook(
      (p: { date: string; items: Alert[] }) =>
        useStickyUnion<Alert>(p.items, {
          key: keyFn,
          storageKey: slot('lottery', p.date, 'sigA'),
        }),
      { initialProps: { date, items } },
    );
  }

  it('deletes the same feed’s other days on mount and keeps every slot of the live day', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${TODAY}T17:00:00Z`));
    put(slot('lottery', PAST, 'sigA'));
    put(slot('lottery', NEXT, 'sigA'));
    put(slot('lottery', TODAY, 'sigB'));
    put(slot('lottery', TODAY));
    for (const k of bystanders) localStorage.setItem(k, 'keep-me');

    renderFeed(TODAY);

    expect(has(slot('lottery', PAST, 'sigA'))).toBe(false);
    expect(has(slot('lottery', NEXT, 'sigA'))).toBe(false);
    expect(has(slot('lottery', TODAY, 'sigB'))).toBe(true);
    expect(has(slot('lottery', TODAY))).toBe(true);
    for (const k of bystanders) expect(localStorage.getItem(k)).toBe('keep-me');
  });

  it('a panel mounted on a past date sweeps the other past days, not the live day’s slots', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${TODAY}T17:00:00Z`));
    put(slot('lottery', TODAY, 'sigA'));
    put(slot('lottery', TODAY, 'sigB'));
    put(slot('lottery', '2026-06-01', 'sigA'));
    for (const k of bystanders) localStorage.setItem(k, 'keep-me');

    renderFeed(PAST);

    // Relative to the key's date (PAST) this deleted today's slots.
    expect(has(slot('lottery', TODAY, 'sigA'))).toBe(true);
    expect(has(slot('lottery', TODAY, 'sigB'))).toBe(true);
    expect(has(slot('lottery', '2026-06-01', 'sigA'))).toBe(false);
    for (const k of bystanders) expect(localStorage.getItem(k)).toBe('keep-me');
  });

  it('a detour to a past date deletes nothing of the live day’s, and the union is there on return', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${TODAY}T17:00:00Z`));
    put(slot('lottery', TODAY, 'sigB'));
    const { result, rerender } = renderFeed(TODAY, [{ id: 'a', pct: 1 }]);

    rerender({ date: PAST, items: [] });

    // The key's slot for today was flushed on the key change, and kept.
    expect(has(slot('lottery', TODAY, 'sigA'))).toBe(true);
    expect(has(slot('lottery', TODAY, 'sigB'))).toBe(true);

    rerender({ date: TODAY, items: [] });
    expect(result.current.map((r) => r.id)).toEqual(['a']);
  });

  it('does not sweep when only the key changes within the live day, or when the key is not a feed-union key', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${TODAY}T17:00:00Z`));
    const { rerender } = renderFeed(TODAY);
    // Written after the mount sweep, on a day that is not the live day.
    put(slot('lottery', PAST, 'sigA'));

    rerender({ date: TODAY, items: [{ id: 'a', pct: 1 }] });
    rerender({ date: PAST, items: [] });

    expect(has(slot('lottery', PAST, 'sigA'))).toBe(true);

    const plain = renderHook(() =>
      useStickyUnion<Alert>([], { key: keyFn, storageKey: 'not-a-feed-key' }),
    );
    expect(plain.result.current).toEqual([]);
    expect(has(slot('lottery', PAST, 'sigA'))).toBe(true);
  });

  it('the roll deletes the prior day’s slots, the one flushed in that commit included, and keeps the new day’s, other feeds, malformed and unrelated keys', () => {
    vi.useFakeTimers();
    // 23:59:30 ET on TODAY. The panel's key follows the shared ET clock.
    vi.setSystemTime(new Date('2026-06-08T03:59:30Z'));
    put(slot('lottery', TODAY, 'sigB'));
    for (const k of bystanders) localStorage.setItem(k, 'keep-me');
    const { rerender } = renderHook(
      ({ items }: { items: Alert[] }) => {
        const today = useETToday();
        return useStickyUnion<Alert>(items, {
          key: keyFn,
          storageKey: slot('lottery', today, 'sigA'),
        });
      },
      { initialProps: { items: [] as Alert[] } },
    );
    // Written after the mount sweep: the new day's own slot and a sibling.
    put(slot('lottery', NEXT, 'sigB'));
    expect(has(slot('lottery', TODAY, 'sigB'))).toBe(true);

    // An ingest half a second before the roll stages a debounced write for
    // the old day's slot; the roll (1 s past midnight) lands inside its window.
    act(() => {
      vi.advanceTimersByTime(30_500);
    });
    rerender({ items: [{ id: 'a', pct: 1 }] });
    expect(has(slot('lottery', TODAY, 'sigA'))).toBe(false); // staged, not written
    act(() => {
      vi.advanceTimersByTime(600);
    });

    // The commit that carried the new day flushed the old slot, then swept it.
    expect(has(slot('lottery', TODAY, 'sigA'))).toBe(false);
    expect(has(slot('lottery', TODAY, 'sigB'))).toBe(false);
    expect(has(slot('lottery', NEXT, 'sigB'))).toBe(true);
    for (const k of bystanders) expect(localStorage.getItem(k)).toBe('keep-me');
  });
});
