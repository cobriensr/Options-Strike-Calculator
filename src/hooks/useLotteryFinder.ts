/**
 * useLotteryFinder — fetches /api/lottery-finder with a per-minute
 * scrubber bucket, paginated results (50 per page by default), and the
 * full filter chip set (ticker / reload / cheap-call-PM / mode /
 * optionType / TOD). Polls every 30s during market hours when no
 * minute is selected and the date is today; otherwise the response is
 * stable and polling is skipped.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { POLL_INTERVALS } from '../constants/index.js';
import { usePolling } from './usePolling.js';
import type {
  LotteryFinderResponse,
  LotteryFire,
  LotteryMode,
  LotterySortMode,
  OptionType,
  TimeOfDay,
} from '../components/LotteryFinder/types.js';
import { getErrorMessage } from '../utils/error.js';

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
  /** 0-based page index (offset = page * limit). */
  page?: number;
  /** Page size. Default 50. */
  pageSize?: number;
}

interface State {
  fires: LotteryFire[];
  /**
   * Pinned "Hot Right Now" rows — top-N reignited chains for the day,
   * served independent of pagination so the section stays visible on
   * every page. Always populated from the server when present;
   * back-compat default is `[]`.
   */
  reignitedFires: LotteryFire[];
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
  /** Total matching fires across all pages. */
  total: number;
  /** Effective limit (page size) the endpoint applied. */
  limit: number;
  /** Effective offset the endpoint applied. */
  offset: number;
  /** True when a Next page exists. */
  hasMore: boolean;
}

const INITIAL_STATE: State = {
  fires: [],
  reignitedFires: [],
  loading: true,
  error: null,
  fetchedAt: null,
  total: 0,
  limit: 0,
  offset: 0,
  hasMore: false,
};

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
  page = 0,
  pageSize = 50,
}: UseLotteryFinderArgs): State & { refetch: () => void } {
  const [state, setState] = useState<State>(INITIAL_STATE);
  const abortRef = useRef<AbortController | null>(null);

  const fetchOnce = useCallback(async () => {
    // Cancel any in-flight request before starting a new one — prevents
    // a stale poll from clobbering the user's just-scrubbed state.
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
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
      const res = await fetch(`/api/lottery-finder?${params.toString()}`, {
        credentials: 'include',
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as LotteryFinderResponse;

      // The signal might have been aborted between fetch resolution
      // and JSON parse; bail before clobbering newer state.
      if (ctrl.signal.aborted) return;
      setState({
        fires: json.fires,
        reignitedFires: json.reignitedFires ?? [],
        loading: false,
        error: null,
        fetchedAt: Date.now(),
        total: json.total,
        limit: json.limit,
        offset: json.offset,
        hasMore: json.hasMore,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      // Defensive: a non-abort error from a request that was just
      // superseded by a newer fetch must not surface as the live error.
      if (ctrl.signal.aborted) return;
      setState((prev) => ({
        ...prev,
        loading: false,
        error: getErrorMessage(err),
      }));
    }
  }, [
    date,
    minute,
    ticker,
    reload,
    cheapCallPm,
    mode,
    optionType,
    tod,
    sort,
    minScore,
    minPremium,
    page,
    pageSize,
  ]);

  // Eager mount fetch — usePolling only schedules the recurring tick.
  useEffect(() => {
    void fetchOnce();
  }, [fetchOnce]);

  // No polling when the user is on a specific minute (historical bucket —
  // won't change) or browsing past page 0 (would shift their cursor on
  // every poll).
  usePolling(
    () => {
      void fetchOnce();
    },
    POLL_INTERVALS.OTM_FLOW,
    [marketOpen, !minute, page === 0],
  );

  // Cancel any in-flight request on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  return useMemo(() => ({ ...state, refetch: fetchOnce }), [state, fetchOnce]);
}
