/**
 * useSilentBoomFeed — fetches /api/silent-boom-feed with filter chips
 * and pagination. Polls every 30s during market hours when on page 0
 * AND the selected date is today (historical days are static).
 *
 * Mirrors the pattern in useLotteryFinder.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { POLL_INTERVALS } from '../constants/index.js';
import type {
  OptionType,
  SilentBoomAlert,
  SilentBoomAskPctBand,
  SilentBoomBurstColor,
  SilentBoomDteBucket,
  SilentBoomFeedResponse,
  SilentBoomSortMode,
  SilentBoomTod,
} from '../components/SilentBoom/types.js';
import { getErrorMessage } from '../utils/error.js';

interface UseSilentBoomFeedArgs {
  date: string;
  marketOpen: boolean;
  /** When true, the date is in the past — feed is static, skip polling. */
  historical?: boolean;
  ticker?: string | null;
  optionType?: OptionType | null;
  /** Vol/OI floor — UI default 0.5 to trim to actionable density. */
  minVolOi?: number;
  /** Spike-ratio floor. */
  minSpikeRatio?: number;
  /** Composite-score floor — Tier 1 = 21, Tier 2 = 8. */
  minScore?: number | null;
  /** Time-of-day filter — null = all phases. */
  tod?: SilentBoomTod | null;
  /** DTE bucket filter — null = all DTEs. */
  dte?: SilentBoomDteBucket | null;
  /** Burst-color category filter — null = all colors. */
  burst?: SilentBoomBurstColor | null;
  /** Ask% band filter — null = all bands. */
  askPctBand?: SilentBoomAskPctBand | null;
  /**
   * Aggressive Premium chip — single toggle that ANDs the trader's
   * UW filter (premium ≥ $100K, DTE ≤ 8, vol/OI > 1, single-leg, OTM)
   * onto the existing filters. Server-side enforced in
   * api/silent-boom-feed.ts.
   */
  aggressivePremium?: boolean;
  sort?: SilentBoomSortMode;
  page?: number;
  pageSize?: number;
}

interface State {
  alerts: SilentBoomAlert[];
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

const INITIAL_STATE: State = {
  alerts: [],
  loading: true,
  error: null,
  fetchedAt: null,
  total: 0,
  limit: 0,
  offset: 0,
  hasMore: false,
};

export function useSilentBoomFeed({
  date,
  marketOpen,
  historical = false,
  ticker = null,
  optionType = null,
  minVolOi = 0.5,
  minSpikeRatio = 0,
  minScore = null,
  tod = null,
  dte = null,
  burst = null,
  askPctBand = null,
  aggressivePremium = false,
  sort = 'newest',
  page = 0,
  pageSize = 50,
}: UseSilentBoomFeedArgs): State & { refetch: () => void } {
  const [state, setState] = useState<State>(INITIAL_STATE);
  const abortRef = useRef<AbortController | null>(null);

  const fetchOnce = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const params = new URLSearchParams({
        date,
        limit: String(pageSize),
        offset: String(page * pageSize),
        minVolOi: String(minVolOi),
        minSpikeRatio: String(minSpikeRatio),
        sort,
      });
      if (ticker) params.set('ticker', ticker);
      if (optionType) params.set('optionType', optionType);
      if (minScore != null) params.set('minScore', String(minScore));
      if (tod) params.set('tod', tod);
      if (dte) params.set('dte', dte);
      if (burst) params.set('burst', burst);
      if (askPctBand) params.set('askPctBand', askPctBand);
      if (aggressivePremium) params.set('aggressivePremium', 'true');
      const res = await fetch(`/api/silent-boom-feed?${params.toString()}`, {
        credentials: 'include',
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as SilentBoomFeedResponse;
      if (ctrl.signal.aborted) return;
      setState({
        alerts: json.alerts,
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
      if (ctrl.signal.aborted) return;
      setState((prev) => ({
        ...prev,
        loading: false,
        error: getErrorMessage(err),
      }));
    }
  }, [
    date,
    ticker,
    optionType,
    minVolOi,
    minSpikeRatio,
    minScore,
    tod,
    dte,
    burst,
    askPctBand,
    aggressivePremium,
    sort,
    page,
    pageSize,
  ]);

  useEffect(() => {
    fetchOnce();
    if (!marketOpen) return;
    if (page > 0) return;
    if (historical) return;
    const id = setInterval(fetchOnce, POLL_INTERVALS.OTM_FLOW);
    return () => clearInterval(id);
  }, [fetchOnce, marketOpen, page, historical]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return useMemo(() => ({ ...state, refetch: fetchOnce }), [state, fetchOnce]);
}
