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

import { useEffect, useMemo, useRef, useState } from 'react';
import { POLL_INTERVALS } from '../constants/index.js';
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
  if (showAll) params.set('showAll', 'true');
  const url = `/api/lottery-finder?${params.toString()}`;

  // Original gates were `[marketOpen, !minute, page === 0]` — fold the
  // `!minute` and `page === 0` gates into the historical flag so the
  // minute-scrub view and paginated views single-fetch instead of polling.
  const fetched = useFetchedData<LotteryFinderResponse>({
    url,
    marketOpen,
    pollIntervalMs: POLL_INTERVALS.OTM_FLOW,
    historical: minute != null || page !== 0,
  });

  // Per-URL response cache. `useFetchedData` keeps the previous URL's
  // `data` while the next URL's fetch is in flight (stale-while-
  // revalidate), so the UI never blanks. But after a fetch resolves,
  // its `data` is "owned by" the URL that was current when that fetch
  // started — clicking back to a previously-loaded page would otherwise
  // show stale data from the latest page until the new fetch finishes.
  // The cache fixes that: the read path consults the cache for the
  // current URL synchronously inside `useMemo`, so a back-navigation
  // hit paints in the same render as the URL change (no 1-frame stale
  // flash), and `useFetchedData` revalidates in the background.
  const cacheRef = useRef<Map<string, LotteryFinderResponse>>(new Map());
  // Tracks the `fetchedAt` of the most recent fetch we've written to
  // the cache, used by the save-effect below to ignore URL-only
  // changes (where `fetched.data` still belongs to the prior URL).
  const lastSavedFetchedAtRef = useRef<number | null>(null);
  // Bumped whenever the cache is mutated so the read-path `useMemo`
  // recomputes. Without this the memo would miss writes — `cacheRef`
  // itself is not a dep, only the version counter is.
  const [cacheVersion, setCacheVersion] = useState(0);

  // When a fresh fetch resolves, write to cache + bump the version
  // counter so the read-path memo re-runs. Gated on `fetchedAt` so
  // the effect only acts on genuine fetch completions, not on URL-
  // only changes that leave `fetched.data` pointing at the previous
  // URL's response (which would otherwise corrupt the new URL's
  // cache slot).
  useEffect(() => {
    if (fetched.data == null) return;
    if (fetched.fetchedAt == null) return;
    if (fetched.fetchedAt === lastSavedFetchedAtRef.current) return;
    lastSavedFetchedAtRef.current = fetched.fetchedAt;
    const cache = cacheRef.current;
    cache.set(url, fetched.data);
    while (cache.size > PAGE_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest == null) break;
      cache.delete(oldest);
    }
    setCacheVersion((v) => v + 1);
  }, [fetched.data, fetched.fetchedAt, url]);

  return useMemo(() => {
    // Synchronous cache lookup keyed on the current URL. A back-nav
    // hit lands in the same render as the URL change. On a miss we
    // surface `fetched.data` (which `useFetchedData` keeps pinned to
    // the prior URL until the new fetch resolves — preserves
    // stale-while-revalidate for first-visit pages).
    const cached = cacheRef.current.get(url) ?? null;
    const data = cached ?? fetched.data;
    return {
      data,
      loading: fetched.loading && data == null,
      error: fetched.error,
      refresh: fetched.refresh,
      fetchedAt: fetched.fetchedAt,
    };
    // `cacheVersion` is intentionally a dep — it bumps whenever the
    // cache mutates, forcing a recompute that reads the fresh value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetched, url, cacheVersion]);
}
