/**
 * useStickyUnion — absolute "never-vanish" accumulator for alert feeds.
 *
 * Verifies the core contract: items pin forever once seen (for the life
 * of a storageKey), upserts replace in place, a storageKey change resets
 * the union, and the union survives a page refresh via localStorage.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
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
});
