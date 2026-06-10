/**
 * useLotteryFinder — fetches /api/lottery-finder with a per-minute
 * scrubber bucket, paginated results (50 per page by default), and the
 * full filter chip set (ticker / reload / cheap-call-PM / mode /
 * optionType / TOD). Polls every 30s during market hours when no
 * minute is selected and the date is today; otherwise the response is
 * stable and polling is skipped.
 *
 * Phase 2M-5: thin wrapper over `useFetchedData` exposing the canonical
 * `{ data, loading, error, refresh, fetchedAt }` shape. Callers
 * destructure `data?.fires ?? []`, `data?.reignitedFires ?? []`,
 * `data?.total ?? 0`, etc.
 *
 * Page cache: pages > 0 are static (never poll), so the hook keeps an
 * in-memory `Map<url, response>` of the last N URL responses. Going
 * back to a previously-loaded page renders instantly without a
 * roundtrip. The cache is per-hook-instance (lives in a ref), bounded
 * to PAGE_CACHE_MAX entries with FIFO eviction.
 */

import { useEffect, useMemo, useRef } from 'react';
import { POLL_INTERVALS } from '../constants/index.js';
import { getCTDateStr } from '../utils/timezone.js';
import { useFetchedData, type UseFetchedDataResult } from './useFetchedData.js';
import type {
  LotteryFinderResponse,
  LotteryMode,
  LotterySortMode,
  OptionType,
  TimeOfDay,
} from '../components/LotteryFinder/types.js';

interface UseLotteryFinderArgs {
  /** YYYY-MM-DD trading day. */
  date: string;
  /**
   * Optional 1-minute point-in-time bucket. When set, the endpoint
   * returns only fires whose trigger_time_ct is in
   * `[minute, minute + 1m)`. Drives the time-scrubber UX.
   */
  minute?: string | null;
  marketOpen: boolean;
  /** Filter by ticker. `null` returns all. */
  ticker?: string | null;
  /** Filter to RE-LOAD only. */
  reload?: boolean | null;
  /** Filter to cheap-call-PM only. */
  cheapCallPm?: boolean | null;
  /** Filter by mode (Mode A or Mode B). */
  mode?: LotteryMode | null;
  /** Filter by option type ('C' / 'P'). */
  optionType?: OptionType | null;
  /** Filter by time-of-day bucket. */
  tod?: TimeOfDay | null;
  /** Sort mode for the result set. Default 'chronological'. */
  sort?: LotterySortMode;
  /** Minimum score floor (Tier 1 = 18 enables High Conviction filter). */
  minScore?: number | null;
  /**
   * Numeric premium floor in dollars
   * (entry_price * trigger_window_size * 100). 0 / null = no floor.
   * Server-side filter so pagination + ticker counts reflect the
   * post-filter result. Mirrors the SilentBoom feed param.
   */
  minPremium?: number | null;
  /**
   * Chain-day fire_count floor. Server-side so pagination reflects
   * the post-filter total. 0/1 = no floor; >=N matches MIN_FIRE_COUNT
   * chips (3 / 8 / 16) in the LotteryFinder toolbar.
   */
  minFireCount?: number | null;
  /**
   * Chain-day fire_count CAP — show only chains with AT MOST N fires.
   * Inverse of `minFireCount`: hides high-fire-count "spam" chains.
   * Server-side so pagination + ticker counts reflect the post-filter
   * total. null / 0 = no cap (default OFF). Unlike the floor, a cap of
   * 1 IS meaningful (single-fire chains only), so the gate is >= 1.
   */
  maxFireCount?: number | null;
  /**
   * TAKE-IT calibrated P(peak >= +20%) floor. 0 / null = no floor.
   * Server-side so pagination + ticker counts reflect the post-
   * filter total. Mirrors the TAKEIT_FLOOR chip group; default UI
   * value is 0.70.
   */
  minTakeitProb?: number | null;
  /**
   * Phase 4 inversion-quality escape hatch. When `true`, the URL
   * builder appends `showAll=true` and the server bypasses the bottom-
   * quintile (Q1/Q2) inversion-quality suppression. Off by default —
   * the lottery feed is intentionally narrowed.
   */
  showAll?: boolean;
  /** 0-based page index (offset = page * limit). */
  page?: number;
  /** Page size. Default 50. */
  pageSize?: number;
}

/** Maximum cached page responses kept per hook instance. ~10 pages
 *  covers two full filter views of forward + back navigation. Each
 *  response is ~50 fires of trimmed JSON; well under the 5 MB Vercel
 *  payload budget even at the cap. */
const PAGE_CACHE_MAX = 10;

export function useLotteryFinder({
  date,
  minute,
  marketOpen,
  ticker = null,
  reload = null,
  cheapCallPm = null,
  mode = null,
  optionType = null,
  tod = null,
  sort = 'chronological',
  minScore = null,
  minPremium = null,
  minFireCount = null,
  maxFireCount = null,
  minTakeitProb = null,
  showAll = false,
  page = 0,
  pageSize = 50,
}: UseLotteryFinderArgs): UseFetchedDataResult<LotteryFinderResponse> {
  const params = new URLSearchParams({
    date,
    limit: String(pageSize),
    offset: String(page * pageSize),
  });
  if (minute) params.set('minute', minute);
  if (ticker) params.set('ticker', ticker);
  if (reload != null) params.set('reload', String(reload));
  if (cheapCallPm != null) params.set('cheapCallPm', String(cheapCallPm));
  if (mode != null) params.set('mode', mode);
  if (optionType != null) params.set('optionType', optionType);
  if (tod != null) params.set('tod', tod);
  if (sort !== 'chronological') params.set('sort', sort);
  if (minScore != null) params.set('minScore', String(minScore));
  if (minPremium != null && minPremium > 0)
    params.set('minPremium', String(minPremium));
  if (minFireCount != null && minFireCount > 1)
    params.set('minFireCount', String(minFireCount));
  if (maxFireCount != null && maxFireCount >= 1)
    params.set('maxFireCount', String(maxFireCount));
  if (minTakeitProb != null && minTakeitProb > 0)
    params.set('minTakeitProb', String(minTakeitProb));
  if (showAll) params.set('showAll', 'true');
  const url = `/api/lottery-finder?${params.toString()}`;

  // Original gates were `[marketOpen, !minute, page === 0]` — fold the
  // `!minute` and `page === 0` gates into the historical flag so the
  // minute-scrub view and paginated views single-fetch instead of polling.
  //
  // FIX 2: also fold in `date !== today` — a PAST trading day is an immutable
  // snapshot, so polling it every 30s just re-fetches identical data (and, in
  // concert with the component's engaged gate, would re-ingest historical rows
  // into the live never-vanish union). `todayCt` here is computed exactly like
  // the component's `todayCt()`: `getCTDateStr(new Date())` uses the same
  // `Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', ... })`.
  //
  // The cross-day staleness gate lives in the primitive via `requestKey`/
  // `responseKey`: a prior-day response is nulled at the data layer BEFORE
  // the page cache reads `fetched.data`, so the cache never stores cross-day
  // data (the `if (fetched.data == null) return` guard in the save effect
  // skips a gated-null response) and every derived value stays coherent.
  const todayCt = getCTDateStr(new Date());
  const fetched = useFetchedData<LotteryFinderResponse>({
    url,
    marketOpen,
    pollIntervalMs: POLL_INTERVALS.OTM_FLOW,
    historical: minute != null || page !== 0 || date !== todayCt,
    requestKey: date,
    responseKey: (d) => d.date?.slice(0, 10),
  });

  // Per-URL response cache. `useFetchedData` keeps the previous URL's
  // `data` while the next URL's fetch is in flight (stale-while-
  // revalidate), so the UI never blanks. After a fetch resolves, its
  // `data` is "owned by" the URL that was current when that fetch
  // started — clicking back to a previously-loaded page would
  // otherwise show stale data from the latest page until the new
  // fetch finishes. The cache fixes that: the read path consults the
  // cache for the current URL synchronously inside `useMemo`, so a
  // back-navigation hit paints in the same render as the URL change
  // (no 1-frame stale flash), and `useFetchedData` revalidates in the
  // background.
  //
  // FIX 3 — PER-URL freshness (was a single global `lastSavedFetchedAt`):
  // each url's cache entry stores `{ data, fetchedAt }`. The freshness check
  // compares the CURRENT url's saved `fetchedAt`, never a global one. The old
  // global check had a one-frame bug: on a page-0 poll the global lastSaved
  // advanced to that tick's time; a back-nav to a cached page then saw
  // `fetched.fetchedAt` (the page-0 tick) > global lastSaved (briefly, before
  // the save effect caught up) and returned page-0's rows under the other
  // page's url for one frame — the exact stale flash the cache exists to kill.
  //
  // Ownership guard: `fetched.data` may carry a payload that belongs to a
  // DIFFERENT url (stale-while-revalidate carryover after a navigation). We
  // only treat it as "for the current url" when its echoed `offset` matches
  // the requested `offset` for this page. That keeps the no-flicker poll-tick
  // behavior (same url → offset matches → prefer the fresh tick) while
  // preventing a just-resolved other-page payload from being mis-served — or
  // mis-saved into this url's cache slot.
  // Offset the current url requests; the response echoes it. The ownership
  // guard below treats `fetched.data` as "for this url" only when its echoed
  // `offset` matches — distinguishing a same-url poll tick (offset matches →
  // prefer the fresh payload, no flicker) from a stale-while-revalidate
  // carryover of another page's payload after a navigation (offset differs →
  // never preferred, never cached under this url).
  const requestedOffset = page * pageSize;

  interface CacheEntry {
    data: LotteryFinderResponse;
    fetchedAt: number;
  }
  const cacheRef = useRef<Map<string, CacheEntry>>(new Map());

  useEffect(() => {
    if (fetched.data == null) return;
    if (fetched.fetchedAt == null) return;
    // Only attribute this payload to the current url when it actually belongs
    // to it (offset echo matches). A carried-over other-page payload must not
    // poison this url's cache slot.
    if (fetched.data.offset !== requestedOffset) return;
    const cache = cacheRef.current;
    const prev = cache.get(url);
    if (prev != null && prev.fetchedAt === fetched.fetchedAt) return;
    cache.set(url, { data: fetched.data, fetchedAt: fetched.fetchedAt });
    while (cache.size > PAGE_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest == null) break;
      cache.delete(oldest);
    }
  }, [fetched.data, fetched.fetchedAt, url, requestedOffset]);

  return useMemo(() => {
    // Per-url freshness: prefer `fetched.data` only when it BELONGS to this
    // url (offset echo matches) AND is newer than this url's saved entry (the
    // save effect hasn't written it yet — that one-frame window after a
    // same-url poll tick resolves). Otherwise the cache holds the latest value
    // for this url — use it (back-nav hit) or fall back to whatever
    // `useFetchedData` is still surfacing.
    const cachedEntry = cacheRef.current.get(url) ?? null;
    const savedFetchedAt = cachedEntry?.fetchedAt ?? 0;
    const fetchedIsFresher =
      fetched.fetchedAt != null &&
      fetched.fetchedAt > savedFetchedAt &&
      fetched.data != null &&
      fetched.data.offset === requestedOffset;
    const cached = cachedEntry?.data ?? null;
    const data = fetchedIsFresher ? fetched.data : (cached ?? fetched.data);
    return {
      data,
      loading: fetched.loading && data == null,
      error: fetched.error,
      refresh: fetched.refresh,
      fetchedAt: fetched.fetchedAt,
    };
  }, [fetched, url, requestedOffset]);
}
