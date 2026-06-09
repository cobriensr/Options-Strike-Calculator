/**
 * useNeverVanishFeed — generic never-vanish feed orchestrator.
 *
 * Consolidates the ~120 lines of identical orchestration that LotteryFinder
 * and SilentBoom previously hand-rolled around `useStickyUnion`:
 *
 *   - union + engaged-gate (live view pins; scrub / paged views pass through)
 *   - server-anchored pagination (totalPages NEVER inflated by union size)
 *   - pinned-count `total` floor (the "N pinned" display)
 *   - per-ticker MAX-merge ticker counts (server count wins where reported,
 *     union backfills any ticker the server later dropped)
 *   - the pinned key set, exposed for caller-side page>0 dedup and (Lottery)
 *     the reignited-vs-ticker-group partition.
 *
 * Engaged vs. disengaged
 * ----------------------
 * `engaged` is the live polling view (today, all-day, page 0) — the only view
 * that re-polls and can therefore drop a row out from under the trader. When
 * engaged the hook returns the WHOLE never-vanish union and floors `total` at
 * its length. When disengaged (minute scrub, paged offset, historical replay)
 * the hook returns the raw `fetched` server slice and the raw `serverTotal` —
 * those are distinct point-in-time / offset views where pinning would wrongly
 * pile unrelated rows together. The underlying union still ingests only when
 * engaged (the caller passes `fetched` while engaged, `[]` otherwise — see
 * below), so the persisted union survives the detour and resumes on return.
 *
 * Pagination coherence (finding #3 + filtered-set pager bug)
 * ----------------------------------------------------------
 * Three "size" numbers used to drive three controls and could disagree:
 * pager VISIBILITY floored at the union length, the page LABEL anchored to
 * `ceil(serverTotal / pageSize)`, and the Next button driven by the raw
 * server `hasMore`. With a filter active the server set is small (one page,
 * `hasMore` false) yet the page-0 union can hold MORE than `pageSize` pinned
 * rows — so the pager showed, the label said "1", and Next + page>0 dedup
 * produced a one-row page 2 plus a phantom trailing page.
 *
 * The hook now OWNS pagination and keeps the three numbers consistent by
 * branching on whether the union is COMPLETE (holds the whole server set):
 *
 *   - Union-complete (engaged AND `serverTotal <= pageSize` → the whole
 *     filtered set fit in page 0, so the union is the complete ordered set):
 *     paginate the UNION itself. One ordered list backs every page, so `rows`
 *     is the `page` slice, `total`/`totalPages` come from the union length,
 *     and `canPrev`/`canNext` derive from the same length. No server
 *     round-trip, no dedup hole, no phantom page. (We key on `serverTotal`,
 *     not `hasMore` — `hasMore` is false on the LAST page of ANY multi-page
 *     set, which would wrongly strand a large set's tail.)
 *   - Server-has-more (engaged AND `serverTotal > pageSize` → the union only
 *     saw page 0 and the server holds an unreachable tail): stay SERVER-
 *     anchored (`totalPages = ceil(serverTotal / pageSize)`, Next via server
 *     `hasMore`). `rows` is the WHOLE union (never-vanish) — the caller
 *     renders it on page 0 and dedups its own server slices on later pages.
 *   - Disengaged (minute/bucket scrub, paged offset, historical replay):
 *     pass-through server slice; `canPrev = page > 0`, `canNext = hasMore`.
 *
 * `page` and `ingest` default to page 0 / `engaged` when omitted, so callers
 * that don't paginate keep the original single-page behavior.
 *
 * Ingest gating
 * -------------
 * Whether the union GROWS this render is `ingest` (defaults to `engaged`).
 * In union-complete mode the caller keeps `engaged` true across pages so the
 * union still backs the slices, but passes `ingest === false` on pages > 0 so
 * a later server slice can't pile onto the union (it normally passes `[]` as
 * `fetched` on those pages anyway; `ingest` is the explicit belt-and-braces
 * gate). The hook forwards to `useStickyUnion` only when `ingest` is true.
 */

import { useMemo } from 'react';
import { useStickyUnion } from './useStickyUnion.js';

export interface TickerCount {
  ticker: string;
  count: number;
}

export interface UseNeverVanishFeedArgs<T> {
  /** The current server response slice for this feed. */
  fetched: T[];
  /**
   * Live view (today, all-day, page 0) — the only view that re-polls and can
   * drop a row. When true the hook returns the whole union; when false it
   * returns `fetched` verbatim.
   */
  engaged: boolean;
  /**
   * localStorage slot for the union. The caller MUST include the trading day
   * AND a signature of the active server-side filters, e.g.
   * `feed-union:lottery:${date}:${filterSig}`, so changing a server filter
   * rescopes the union (previously-excluded rows drop) and a new day resets it.
   */
  storageKey: string;
  /** Stable identity for a row. */
  key: (t: T) => string;
  /** Server's reachable row count for the day (drives pagination). */
  serverTotal: number;
  /**
   * Whether the server can serve another page. Drives the Next gate in the
   * server-anchored (large-set) mode. NOTE: union-completeness keys on
   * `serverTotal <= pageSize`, NOT this flag — `hasMore` is false on the last
   * page of any multi-page set.
   */
  hasMore: boolean;
  /** Page size — pagination divisor. */
  pageSize: number;
  /**
   * Current 0-based page index. Defaults to 0. In union-complete mode the
   * hook slices the union by this; in server-anchored / disengaged modes it
   * only informs `canPrev`. The caller still drives the server fetch.
   */
  page?: number;
  /**
   * Whether the union should GROW this render. Defaults to `engaged`. Pass
   * `false` on pages > 0 in union-complete mode so a later server slice can't
   * pile onto the page-0 union.
   */
  ingest?: boolean;
  /** Symbol accessor for the per-ticker count merge. */
  getSymbol: (t: T) => string;
  /**
   * Page-independent all-day ticker counts from the server. Optional — when
   * absent the merged counts are union-only.
   */
  serverTickerCounts?: ReadonlyArray<TickerCount>;
  /** Genuinely-retracted keys — passed through to the union's only delete path. */
  tombstones?: ReadonlySet<string>;
}

export interface UseNeverVanishFeedResult<T> {
  /**
   * Union-complete → the `page` slice of the union; server-has-more (engaged)
   * → the WHOLE union (caller paginates/dedups); disengaged → `fetched`.
   */
  rows: T[];
  /** Engaged → max(serverTotal, union length); disengaged → serverTotal. */
  total: number;
  /**
   * Page count that BACKS the slices: union-complete → ceil(union / pageSize);
   * otherwise ceil(serverTotal / pageSize). Always ≥ 1.
   */
  totalPages: number;
  /** Server's reachable-more flag, surfaced for the Next gate. */
  hasMore: boolean;
  /** True when there is a previous page to navigate to (page > 0). */
  canPrev: boolean;
  /**
   * True when there is a next page. Union-complete → page < totalPages - 1;
   * otherwise the server `hasMore`. Mutually consistent with `totalPages`.
   */
  canNext: boolean;
  /** Per-ticker MAX(server, union); server order preserved, union appended. */
  tickerCounts: TickerCount[];
  /** The pinned union key set, for caller-side page>0 dedup / partition. */
  unionKeys: ReadonlySet<string>;
}

export function useNeverVanishFeed<T>(
  args: UseNeverVanishFeedArgs<T>,
): UseNeverVanishFeedResult<T> {
  const {
    fetched,
    engaged,
    storageKey,
    key,
    serverTotal,
    hasMore,
    pageSize,
    getSymbol,
    serverTickerCounts,
    tombstones,
    page = 0,
    ingest = engaged,
  } = args;

  // The never-vanish accumulator. Ingest is gated by `ingest` (defaults to
  // `engaged`): we forward `fetched` only when the union should grow this
  // render, so a disengaged view — or a page > 0 in union-complete mode —
  // never grows the union.
  const union = useStickyUnion(ingest ? fetched : [], {
    key,
    storageKey,
    ...(tombstones !== undefined && { tombstones }),
  });

  // Pinned key set — exposed for the caller's page>0 dedup and (Lottery) the
  // reignited-vs-ticker-group partition. Always reflects the persisted union,
  // even on disengaged paged views (the hook rehydrates from localStorage),
  // so a page-2 duplicate of a page-0-pinned row can be dropped.
  const unionKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const u of union) keys.add(key(u));
    return keys;
  }, [union, key]);

  // `total` floors at the union length in the live view (so the header / pager
  // never claim fewer rows than are actually rendered); disengaged → server
  // total.
  const total = engaged ? Math.max(serverTotal, union.length) : serverTotal;

  // The union is COMPLETE — i.e. it holds the whole server set, so it is the
  // authoritative ordered list — exactly when we're engaged AND the entire
  // filtered server set fits in one page (`serverTotal <= pageSize`): page 0
  // already returned every row the set has, so there is no unreachable server
  // tail. In that case we paginate the union itself so the pager visibility,
  // the page label, and the Next gate all derive from the SAME union length
  // and cannot disagree (the filtered-set pager bug).
  //
  // `serverTotal <= pageSize` (a page-INDEPENDENT property of the set) is the
  // right signal, NOT `!hasMore`: the server reports `hasMore` false on the
  // LAST page of ANY multi-page set, so keying on it would wrongly treat the
  // final page of a genuinely large (server-tail) set as union-complete and
  // strand the tail the page-0 union never saw.
  const unionComplete = engaged && serverTotal <= pageSize;

  // Page count that backs the rendered slices. Union-complete → the union
  // length (so overflow pinned rows past pageSize are reachable); otherwise
  // server-anchored to the reachable set (the union only saw page 0, so it
  // must NOT advertise pages the server's `hasMore` can't reach — finding #3).
  const totalPages = unionComplete
    ? Math.max(1, Math.ceil(union.length / pageSize))
    : Math.max(1, Math.ceil(serverTotal / pageSize));

  // `rows`:
  //  - union-complete → the `page` slice of the ordered union (one list backs
  //    every page; never under-filled by a dedup, never a phantom tail);
  //  - engaged + server-has-more → the WHOLE union on page 0 (never-vanish);
  //    the caller renders the deduped server slice on its own later pages;
  //  - disengaged → the raw server slice.
  const rows = useMemo<T[]>(() => {
    if (!engaged) return fetched;
    if (!unionComplete) return union;
    const start = page * pageSize;
    return union.slice(start, start + pageSize);
  }, [engaged, unionComplete, fetched, union, page, pageSize]);

  // Pager flags. Always kept consistent with `totalPages`:
  //  - union-complete → derive Next from the union page count;
  //  - otherwise → defer to the server `hasMore`.
  const canPrev = page > 0;
  const canNext = unionComplete ? page < totalPages - 1 : hasMore;

  // Per-ticker MAX(server, union). Server count wins on tickers it still
  // reports; the union backfills any ticker the server dropped. Only engaged
  // in the live view; paged / scrubbed / historical views show raw server
  // counts. Server count-desc ordering is preserved, union-only tickers
  // appended (sorted desc).
  const tickerCounts = useMemo<TickerCount[]>(() => {
    const serverList = serverTickerCounts ?? [];
    if (!engaged) {
      return serverList.map((t) => ({ ticker: t.ticker, count: t.count }));
    }
    const unionCounts = new Map<string, number>();
    for (const u of union) {
      const sym = getSymbol(u);
      unionCounts.set(sym, (unionCounts.get(sym) ?? 0) + 1);
    }
    const merged = new Map<string, number>();
    for (const t of serverList) merged.set(t.ticker, t.count);
    for (const [ticker, unionCount] of unionCounts) {
      merged.set(ticker, Math.max(merged.get(ticker) ?? 0, unionCount));
    }
    const serverOrder = serverList.map((t) => t.ticker);
    const seen = new Set(serverOrder);
    const extras = [...unionCounts.keys()]
      .filter((t) => !seen.has(t))
      .sort((a, b) => (merged.get(b) ?? 0) - (merged.get(a) ?? 0));
    return [...serverOrder, ...extras].map((ticker) => ({
      ticker,
      count: merged.get(ticker) ?? 0,
    }));
  }, [engaged, union, getSymbol, serverTickerCounts]);

  return {
    rows,
    total,
    totalPages,
    hasMore,
    canPrev,
    canNext,
    tickerCounts,
    unionKeys,
  };
}
