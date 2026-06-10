/**
 * useNeverVanishFeed — generic never-vanish feed orchestrator consolidating
 * the union + engaged-gate + page>0 dedup + server-anchored pagination +
 * per-ticker MAX-merge that LotteryFinder / SilentBoom previously hand-rolled.
 *
 * Contract under test:
 *  - engaged → returns the whole never-vanish union (pins dropped rows);
 *    disengaged → returns the raw `fetched` server slice.
 *  - `totalPages` is SERVER-anchored (ceil(serverTotal / pageSize)) and never
 *    inflated by union size — even when union.length > serverTotal (finding #3).
 *  - `total` floors at union length when engaged (the "N pinned" display) but
 *    pagination never advertises an unreachable page.
 *  - ticker counts are per-ticker MAX(server, union), server order preserved,
 *    union-only tickers appended desc.
 *  - tombstone passthrough reaches the underlying union (retracted rows drop).
 *  - `unionKeys` exposes the pinned key set for caller-side dedup / partition.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useNeverVanishFeed } from '../hooks/useNeverVanishFeed';

interface Row {
  id: string;
  sym: string;
  pct: number;
}

const keyFn = (r: Row): string => r.id;
const symFn = (r: Row): string => r.sym;

const PAGE_SIZE = 50;

beforeEach(() => {
  localStorage.clear();
});

describe('useNeverVanishFeed', () => {
  it('engaged: pins a row the server later drops', () => {
    const a: Row = { id: 'a', sym: 'AAPL', pct: 10 };
    const b: Row = { id: 'b', sym: 'TSLA', pct: 20 };
    const { result, rerender } = renderHook(
      ({ fetched }) =>
        useNeverVanishFeed<Row>({
          fetched,
          engaged: true,
          storageKey: 'feed-union:t:2026-06-07:sig',
          key: keyFn,
          getSymbol: symFn,
          serverTotal: fetched.length,
          hasMore: false,
          pageSize: PAGE_SIZE,
        }),
      { initialProps: { fetched: [a, b] } },
    );
    expect(result.current.rows.map((r) => r.id).sort()).toEqual(['a', 'b']);

    // Server drops 'b'.
    rerender({ fetched: [a] });
    expect(result.current.rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('disengaged: returns the raw fetched slice (no pinning)', () => {
    const a: Row = { id: 'a', sym: 'AAPL', pct: 10 };
    const b: Row = { id: 'b', sym: 'TSLA', pct: 20 };
    const { result, rerender } = renderHook(
      ({ fetched, engaged }) =>
        useNeverVanishFeed<Row>({
          fetched,
          engaged,
          storageKey: 'feed-union:t:2026-06-07:sig',
          key: keyFn,
          getSymbol: symFn,
          serverTotal: fetched.length,
          hasMore: false,
          pageSize: PAGE_SIZE,
        }),
      { initialProps: { fetched: [a, b], engaged: false } },
    );
    expect(result.current.rows.map((r) => r.id)).toEqual(['a', 'b']);

    // Disengaged view passes through; dropping b is reflected verbatim.
    rerender({ fetched: [a], engaged: false });
    expect(result.current.rows.map((r) => r.id)).toEqual(['a']);
  });

  it('totalPages stays server-anchored even when union > serverTotal (#3)', () => {
    // 60 pinned rows in the union but the server only reports total=10.
    // PAGE_SIZE=50 → server reachable set is 1 page. The union rendering
    // 60 rows on the live page must NOT advertise a 2nd (unreachable) page.
    const many: Row[] = Array.from({ length: 60 }, (_, i) => ({
      id: `r${i}`,
      sym: 'AAPL',
      pct: i,
    }));
    const { result } = renderHook(() =>
      useNeverVanishFeed<Row>({
        fetched: many,
        engaged: true,
        storageKey: 'feed-union:t:2026-06-07:sig',
        key: keyFn,
        getSymbol: symFn,
        serverTotal: 10,
        hasMore: false,
        pageSize: PAGE_SIZE,
      }),
    );
    // total floors at union length for the pinned-count display...
    expect(result.current.total).toBe(60);
    // ...but totalPages is ceil(10/50) = 1, NOT ceil(60/50) = 2.
    expect(result.current.totalPages).toBe(1);
    expect(result.current.hasMore).toBe(false);
  });

  it('totalPages reflects serverTotal across multiple pages', () => {
    const { result } = renderHook(() =>
      useNeverVanishFeed<Row>({
        fetched: [],
        engaged: true,
        storageKey: 'feed-union:t:2026-06-07:sig',
        key: keyFn,
        getSymbol: symFn,
        serverTotal: 137,
        hasMore: true,
        pageSize: PAGE_SIZE,
      }),
    );
    // ceil(137 / 50) = 3.
    expect(result.current.totalPages).toBe(3);
  });

  it('ticker counts: per-ticker MAX(server, union), server order preserved', () => {
    const fires: Row[] = [
      { id: 'a1', sym: 'AAPL', pct: 1 },
      { id: 'a2', sym: 'AAPL', pct: 2 },
      { id: 'n1', sym: 'NVDA', pct: 3 },
    ];
    const { result } = renderHook(() =>
      useNeverVanishFeed<Row>({
        fetched: fires,
        engaged: true,
        storageKey: 'feed-union:t:2026-06-07:sig',
        key: keyFn,
        getSymbol: symFn,
        serverTotal: 3,
        hasMore: false,
        pageSize: PAGE_SIZE,
        // Server reports AAPL=1 (UNDER-counts — union has 2), TSLA=5
        // (server-only ticker the union never held).
        serverTickerCounts: [
          { ticker: 'AAPL', count: 1 },
          { ticker: 'TSLA', count: 5 },
        ],
      }),
    );
    const counts = result.current.tickerCounts;
    const map = new Map(counts.map((c) => [c.ticker, c.count]));
    // AAPL: max(server 1, union 2) = 2.
    expect(map.get('AAPL')).toBe(2);
    // TSLA: server-only, preserved at 5.
    expect(map.get('TSLA')).toBe(5);
    // NVDA: union-only (server didn't report it) = 1.
    expect(map.get('NVDA')).toBe(1);
    // Server order preserved first (AAPL, TSLA), union-only appended (NVDA).
    expect(counts.map((c) => c.ticker)).toEqual(['AAPL', 'TSLA', 'NVDA']);
  });

  it('disengaged: ticker counts pass through the raw server counts', () => {
    const { result } = renderHook(() =>
      useNeverVanishFeed<Row>({
        fetched: [{ id: 'a1', sym: 'AAPL', pct: 1 }],
        engaged: false,
        storageKey: 'feed-union:t:2026-06-07:sig',
        key: keyFn,
        getSymbol: symFn,
        serverTotal: 1,
        hasMore: false,
        pageSize: PAGE_SIZE,
        serverTickerCounts: [{ ticker: 'AAPL', count: 9 }],
      }),
    );
    expect(result.current.tickerCounts).toEqual([{ ticker: 'AAPL', count: 9 }]);
  });

  it('tombstone passthrough: a retracted key is removed from the union', () => {
    const a: Row = { id: 'a', sym: 'AAPL', pct: 10 };
    const b: Row = { id: 'b', sym: 'TSLA', pct: 20 };
    const { result, rerender } = renderHook(
      ({ tombstones }) =>
        useNeverVanishFeed<Row>({
          fetched: [a, b],
          engaged: true,
          storageKey: 'feed-union:t:2026-06-07:sig',
          key: keyFn,
          getSymbol: symFn,
          serverTotal: 2,
          hasMore: false,
          pageSize: PAGE_SIZE,
          tombstones,
        }),
      {
        initialProps: {
          tombstones: undefined as ReadonlySet<string> | undefined,
        },
      },
    );
    expect(result.current.rows.map((r) => r.id).sort()).toEqual(['a', 'b']);

    // Tombstone 'b' → it must drop even though it's still in `fetched`.
    rerender({ tombstones: new Set(['b']) });
    expect(result.current.rows.map((r) => r.id)).toEqual(['a']);
  });

  it('FIX 4: exposes pinnedCount (all-day "seen today") stable across the engaged boundary', () => {
    const a: Row = { id: 'a', sym: 'AAPL', pct: 1 };
    const b: Row = { id: 'b', sym: 'TSLA', pct: 2 };
    const { result, rerender } = renderHook(
      ({ engaged, fetched, serverTotal }) =>
        useNeverVanishFeed<Row>({
          fetched,
          engaged,
          storageKey: 'feed-union:t:2026-06-07:sig',
          key: keyFn,
          getSymbol: symFn,
          serverTotal,
          hasMore: false,
          pageSize: PAGE_SIZE,
        }),
      { initialProps: { engaged: true, fetched: [a, b], serverTotal: 2 } },
    );
    // Engaged: both pinned → pinnedCount 2, and total floors at it.
    expect(result.current.pinnedCount).toBe(2);
    expect(result.current.total).toBe(2);

    // Disengaged paged view: server reports only 1 reachable row; `total`
    // collapses to serverTotal but `pinnedCount` stays at the all-day union
    // size so the UI can still label "2 seen today".
    rerender({ engaged: false, fetched: [a], serverTotal: 1 });
    expect(result.current.total).toBe(1);
    expect(result.current.pinnedCount).toBe(2);
  });

  it('exposes unionKeys for caller-side dedup', () => {
    const { result } = renderHook(() =>
      useNeverVanishFeed<Row>({
        fetched: [
          { id: 'a', sym: 'AAPL', pct: 1 },
          { id: 'b', sym: 'TSLA', pct: 2 },
        ],
        engaged: true,
        storageKey: 'feed-union:t:2026-06-07:sig',
        key: keyFn,
        getSymbol: symFn,
        serverTotal: 2,
        hasMore: false,
        pageSize: PAGE_SIZE,
      }),
    );
    expect([...result.current.unionKeys].sort()).toEqual(['a', 'b']);
  });

  it('disengaged: unionKeys still reflects the persisted union (for page>0 dedup)', () => {
    // Engaged mount pins 'a'; on a paged (disengaged) view the union keys
    // must still be exposed so the caller can drop a page>0 duplicate.
    const a: Row = { id: 'a', sym: 'AAPL', pct: 1 };
    const { result, rerender } = renderHook(
      ({ engaged, fetched }) =>
        useNeverVanishFeed<Row>({
          fetched,
          engaged,
          storageKey: 'feed-union:t:2026-06-07:sig',
          key: keyFn,
          getSymbol: symFn,
          serverTotal: fetched.length,
          hasMore: false,
          pageSize: PAGE_SIZE,
        }),
      { initialProps: { engaged: true, fetched: [a] } },
    );
    expect([...result.current.unionKeys]).toEqual(['a']);

    // Flip to a paged view: rows pass through but the union persists.
    rerender({ engaged: false, fetched: [a, { id: 'b', sym: 'T', pct: 2 }] });
    expect(result.current.rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(result.current.unionKeys.has('a')).toBe(true);
  });
});
