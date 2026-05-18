/**
 * useSilentBoomTickerCounts — fetches /api/silent-boom-ticker-counts
 * for the chip strip above SilentBoomSection. Polls on the same 30s
 * cadence as the feed during market hours; static on historical days.
 *
 * Filter surface mirrors useSilentBoomFeed minus ticker (the strip IS
 * the ticker selector), pagination, and sort.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { POLL_INTERVALS } from '../constants/index.js';
import type {
  OptionType,
  SilentBoomAskPctBand,
  SilentBoomBurstColor,
  SilentBoomDteBucket,
  SilentBoomTod,
} from '../components/SilentBoom/types.js';
import { getErrorMessage } from '../utils/error.js';

export interface SilentBoomTickerCount {
  ticker: string;
  count: number;
  peakBestPct: number | null;
  latestBucketCt: string;
}

interface UseSilentBoomTickerCountsArgs {
  date: string;
  marketOpen: boolean;
  /** Historical day → static, skip polling. */
  historical?: boolean;
  optionType?: OptionType | null;
  minVolOi?: number;
  minSpikeRatio?: number;
  minScore?: number | null;
  tod?: SilentBoomTod | null;
  dte?: SilentBoomDteBucket | null;
  /** Numeric DTE floor — 0 = all, N = only dte >= N. */
  minDte?: number;
  /** Numeric premium floor in dollars. */
  minPremium?: number;
  burst?: SilentBoomBurstColor | null;
  askPctBand?: SilentBoomAskPctBand | null;
}

interface State {
  tickers: SilentBoomTickerCount[];
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
}

interface SilentBoomTickerCountsResponse {
  tickers: SilentBoomTickerCount[];
}

const INITIAL_STATE: State = {
  tickers: [],
  loading: true,
  error: null,
  fetchedAt: null,
};

export function useSilentBoomTickerCounts({
  date,
  marketOpen,
  historical = false,
  optionType = null,
  minVolOi = 0.5,
  minSpikeRatio = 0,
  minScore = null,
  tod = null,
  dte = null,
  minDte = 0,
  minPremium = 0,
  burst = null,
  askPctBand = null,
}: UseSilentBoomTickerCountsArgs): State & { refetch: () => void } {
  const [state, setState] = useState<State>(INITIAL_STATE);
  const abortRef = useRef<AbortController | null>(null);

  const fetchOnce = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const params = new URLSearchParams({
        date,
        minVolOi: String(minVolOi),
        minSpikeRatio: String(minSpikeRatio),
      });
      if (optionType) params.set('optionType', optionType);
      if (minScore != null) params.set('minScore', String(minScore));
      if (tod) params.set('tod', tod);
      if (dte) params.set('dte', dte);
      if (minDte > 0) params.set('minDte', String(minDte));
      if (minPremium > 0) params.set('minPremium', String(minPremium));
      if (burst) params.set('burst', burst);
      if (askPctBand) params.set('askPctBand', askPctBand);
      const res = await fetch(
        `/api/silent-boom-ticker-counts?${params.toString()}`,
        { credentials: 'include', signal: ctrl.signal },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as SilentBoomTickerCountsResponse;
      if (ctrl.signal.aborted) return;
      setState({
        tickers: json.tickers,
        loading: false,
        error: null,
        fetchedAt: Date.now(),
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
    optionType,
    minVolOi,
    minSpikeRatio,
    minScore,
    tod,
    dte,
    minDte,
    minPremium,
    burst,
    askPctBand,
  ]);

  useEffect(() => {
    fetchOnce();
    if (!marketOpen) return;
    if (historical) return;
    const id = setInterval(fetchOnce, POLL_INTERVALS.OTM_FLOW);
    return () => clearInterval(id);
  }, [fetchOnce, marketOpen, historical]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return useMemo(() => ({ ...state, refetch: fetchOnce }), [state, fetchOnce]);
}
