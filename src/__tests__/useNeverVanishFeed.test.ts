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

  it('union-complete: totalPages tracks the union when it holds the whole set', () => {
    // 60 pinned rows in the union; the server reports total=10 with
    // hasMore=false — i.e. the page-0 fetch already returned EVERY server
    // row, so the union is the complete ordered set. PAGE_SIZE=50 → the
    // union spans 2 client pages, and the pager MUST offer both so the 10
    // overflow rows are reachable. (Previously this anchored to
    // ceil(serverTotal/pageSize)=1 and stranded the overflow.)
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
    // ...and totalPages tracks the SAME length: ceil(60/50) = 2.
    expect(result.current.totalPages).toBe(2);
    expect(result.current.hasMore).toBe(false);
  });

  it('server-anchored totalPages when the server has an unreachable tail', () => {
    // hasMore=true → the union is incomplete (only saw page 0), so totalPages
    // stays anchored to the server's reachable set: ceil(137 / 50) = 3.
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

  // ── Union-complete client-side pagination (filtered-set pager bug fix) ──
  //
  // Bug repro: with a filter active the server set is small (serverTotal <=
  // pageSize, so the page-0 fetch returns EVERY server row and hasMore is
  // false), but the never-vanish union accumulated MORE rows than pageSize
  // from pins seen earlier in the day. The old hook floored `total` at the
  // union length (→ pager visible because total > pageSize) yet anchored
  // `totalPages` to ceil(serverTotal / pageSize) = 1 and drove Next off the
  // raw server `hasMore`. The three numbers disagreed → "page 2 = one alert"
  // (dedup emptied the server slice) plus a phantom trailing page.
  //
  // Fix contract: when engaged AND the union holds the complete server set
  // (`hasMore` false), the hook paginates the UNION itself. One ordered list
  // backs every page, so visibility / totalPages / canPrev / canNext all
  // derive from the same union length and agree.

  it('union-complete: paginates the union; page 1 is a real second slice', () => {
    // 60 pinned rows, server reports total=10 with hasMore=false (the whole
    // server set already fits in the page-0 union — no unreachable tail).
    const many: Row[] = Array.from({ length: 60 }, (_, i) => ({
      id: `r${i}`,
      sym: 'AAPL',
      pct: i,
    }));
    const { result, rerender } = renderHook(
      ({ page }) =>
        useNeverVanishFeed<Row>({
          fetched: page === 0 ? many : [],
          engaged: true,
          ingest: page === 0,
          page,
          storageKey: 'feed-union:t:2026-06-07:sig',
          key: keyFn,
          getSymbol: symFn,
          serverTotal: 10,
          hasMore: false,
          pageSize: PAGE_SIZE,
        }),
      { initialProps: { page: 0 } },
    );

    // total floors at the union length (the "N pinned" display)...
    expect(result.current.total).toBe(60);
    // ...and BECAUSE the union holds the whole set, totalPages derives from
    // the SAME length: ceil(60/50) = 2, NOT ceil(10/50) = 1.
    expect(result.current.totalPages).toBe(2);
    // Page 0 shows the first 50 union rows.
    expect(result.current.rows).toHaveLength(50);
    expect(result.current.rows.map((r) => r.id)).toEqual(
      many.slice(0, 50).map((r) => r.id),
    );
    // Consistent pager flags: can't go back, can go forward.
    expect(result.current.canPrev).toBe(false);
    expect(result.current.canNext).toBe(true);

    // Page 1: the SECOND union slice — 10 real rows, NOT under-filled by a
    // dedup against the page-0 union (the bug).
    rerender({ page: 1 });
    expect(result.current.rows).toHaveLength(10);
    expect(result.current.rows.map((r) => r.id)).toEqual(
      many.slice(50, 60).map((r) => r.id),
    );
    expect(result.current.total).toBe(60);
    expect(result.current.totalPages).toBe(2);
    // Last page: can go back, cannot go forward → no phantom page 3.
    expect(result.current.canPrev).toBe(true);
    expect(result.current.canNext).toBe(false);
  });

  it('union-complete: pager numbers are mutually consistent (no phantom page)', () => {
    // The exact filtered-set bug: the CURRENT filtered server response is tiny
    // (serverTotal=5, fits in one page → union-complete) but the never-vanish
    // union accumulated 51 pinned rows over the day. The OLD code floored
    // `total` at 51 (→ pager visible via total>50), anchored `totalPages` to
    // ceil(serverTotal/50)=1, and drove Next off the raw server `hasMore` —
    // three numbers that disagreed, yielding a one-row page 2 + phantom page.
    // The fix paginates the union: ceil(51/50)=2, and visibility / label /
    // Next ALL agree.
    const rows: Row[] = Array.from({ length: 51 }, (_, i) => ({
      id: `r${i}`,
      sym: 'AAPL',
      pct: i,
    }));
    const { result, rerender } = renderHook(
      ({ page }) =>
        useNeverVanishFeed<Row>({
          fetched: page === 0 ? rows : [],
          engaged: true,
          ingest: page === 0,
          page,
          storageKey: 'feed-union:t:2026-06-07:sig',
          key: keyFn,
          getSymbol: symFn,
          serverTotal: 5, // tiny filtered set — fits one page (union-complete)
          hasMore: false,
          pageSize: PAGE_SIZE,
        }),
      { initialProps: { page: 0 } },
    );
    expect(result.current.totalPages).toBe(2); // ceil(union 51 / 50)
    expect(result.current.canNext).toBe(true); // page 0 → there IS a page 1
    rerender({ page: 1 });
    expect(result.current.rows).toHaveLength(1); // the one over-flow row
    expect(result.current.canNext).toBe(false); // and NO page 2 (phantom)
    expect(result.current.totalPages).toBe(2); // label still says 2, not 3
  });

  it('server-has-more: union does NOT swallow the unreachable server tail', () => {
    // serverTotal=137 > pageSize with hasMore=true: page 0 only saw 50 of the
    // 137 server rows, so the union is INCOMPLETE. The hook must stay
    // server-anchored (ceil(137/50)=3) and surface the server hasMore for
    // Next — paginating the 50-row union would hide the 87-row server tail.
    const page0: Row[] = Array.from({ length: 50 }, (_, i) => ({
      id: `r${i}`,
      sym: 'AAPL',
      pct: i,
    }));
    const { result } = renderHook(() =>
      useNeverVanishFeed<Row>({
        fetched: page0,
        engaged: true,
        ingest: true,
        page: 0,
        storageKey: 'feed-union:t:2026-06-07:sig',
        key: keyFn,
        getSymbol: symFn,
        serverTotal: 137,
        hasMore: true,
        pageSize: PAGE_SIZE,
      }),
    );
    // Server-anchored: 3 pages, Next reachable via the server.
    expect(result.current.totalPages).toBe(3);
    expect(result.current.canNext).toBe(true);
    // Page 0 still renders the whole union (never-vanish) — not sliced.
    expect(result.current.rows).toHaveLength(50);
  });

  it('disengaged: page flags fall back to server hasMore + page index', () => {
    const { result } = renderHook(() =>
      useNeverVanishFeed<Row>({
        fetched: [{ id: 'a', sym: 'AAPL', pct: 1 }],
        engaged: false,
        ingest: false,
        page: 1,
        storageKey: 'feed-union:t:2026-06-07:sig',
        key: keyFn,
        getSymbol: symFn,
        serverTotal: 70,
        hasMore: true,
        pageSize: PAGE_SIZE,
      }),
    );
    expect(result.current.rows.map((r) => r.id)).toEqual(['a']);
    expect(result.current.totalPages).toBe(2); // ceil(70/50)
    expect(result.current.canPrev).toBe(true); // page 1 > 0
    expect(result.current.canNext).toBe(true); // server hasMore
  });
});
