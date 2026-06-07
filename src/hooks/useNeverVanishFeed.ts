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
 * Pagination coherence (finding #3)
 * ---------------------------------
 * The union may render MORE than `pageSize` pinned rows on the live page —
 * that's the never-vanish behavior and is fine. But it must NOT advertise
 * extra pages the server's `hasMore` can't reach. So `totalPages` is anchored
 * to the SERVER's reachable set (`ceil(serverTotal / pageSize)`), decoupled
 * from `total`. The live page shows ALL `rows` regardless of `pageSize`; only
 * disengaged paged views are server slices, and the pager only ever offers
 * pages the server can actually serve.
 *
 * Ingest gating
 * -------------
 * The caller is responsible for passing `fetched` ONLY while the union should
 * grow — i.e. on the live page 0 — and `[]` (or the engaged flag false) on
 * paged views, so page-2+ rows don't pile onto the page-0 union. The hook
 * forwards `fetched` to `useStickyUnion` verbatim; it does not second-guess
 * the caller's engaged gate.
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
  /** Whether the server can serve another page. */
  hasMore: boolean;
  /** Page size — pagination divisor. */
  pageSize: number;
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
  /** Engaged → the whole union (never-vanish); disengaged → `fetched`. */
  rows: T[];
  /** Engaged → max(serverTotal, union length); disengaged → serverTotal. */
  total: number;
  /** SERVER-anchored: ceil(serverTotal / pageSize). Never inflated by union. */
  totalPages: number;
  /** Server's reachable-more flag, surfaced for the Next gate. */
  hasMore: boolean;
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
  } = args;

  // The never-vanish accumulator. The caller already gates ingest via
  // `engaged` (passing `[]` on paged views), but we also pass the raw
  // `fetched` only when engaged so a disengaged view never grows the union.
  const union = useStickyUnion(engaged ? fetched : [], {
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

  const rows = engaged ? union : fetched;

  // `total` floors at the union length in the live view (so the header / pager
  // never claim fewer rows than are actually rendered) but pagination is
  // anchored to the SERVER's reachable set, so the union rendering > pageSize
  // pinned rows on the live page does NOT advertise an unreachable page.
  const total = engaged ? Math.max(serverTotal, rows.length) : serverTotal;
  const totalPages = Math.max(1, Math.ceil(serverTotal / pageSize));

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

  return { rows, total, totalPages, hasMore, tickerCounts, unionKeys };
}
