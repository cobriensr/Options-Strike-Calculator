/**
 * useLotteryFinderTickerCounts — fetches /api/lottery-finder-ticker-counts
 * for the chip strip above LotteryFinderSection. Chain-day deduped so
 * the count matches the row dedup the main feed performs.
 *
 * Polls on the same 30s cadence as the feed during market hours;
 * static on historical days.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { POLL_INTERVALS } from '../constants/index.js';
import type {
  LotteryMode,
  OptionType,
  TimeOfDay,
} from '../components/LotteryFinder/types.js';
import { getErrorMessage } from '../utils/error.js';

export interface LotteryFinderTickerCount {
  ticker: string;
  count: number;
  peakBestPct: number | null;
  latestTriggerTimeCt: string;
}

interface UseLotteryFinderTickerCountsArgs {
  date: string;
  marketOpen: boolean;
  historical?: boolean;
  reload?: boolean | null;
  cheapCallPm?: boolean | null;
  mode?: LotteryMode | null;
  optionType?: OptionType | null;
  tod?: TimeOfDay | null;
  minScore?: number | null;
  /** Numeric premium floor in dollars. Mirrors the section's
   *  `minPremiumK * 1000` value so the chip-strip counts match the
   *  filtered feed. */
  minPremium?: number;
}

interface State {
  tickers: LotteryFinderTickerCount[];
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
}

interface LotteryFinderTickerCountsResponse {
  tickers: LotteryFinderTickerCount[];
}

const INITIAL_STATE: State = {
  tickers: [],
  loading: true,
  error: null,
  fetchedAt: null,
};

export function useLotteryFinderTickerCounts({
  date,
  marketOpen,
  historical = false,
  reload = null,
  cheapCallPm = null,
  mode = null,
  optionType = null,
  tod = null,
  minScore = null,
  minPremium = 0,
}: UseLotteryFinderTickerCountsArgs): State & { refetch: () => void } {
  const [state, setState] = useState<State>(INITIAL_STATE);
  const abortRef = useRef<AbortController | null>(null);

  const fetchOnce = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const params = new URLSearchParams({ date });
      if (reload != null) params.set('reload', String(reload));
      if (cheapCallPm != null) params.set('cheapCallPm', String(cheapCallPm));
      if (mode) params.set('mode', mode);
      if (optionType) params.set('optionType', optionType);
      if (tod) params.set('tod', tod);
      if (minScore != null) params.set('minScore', String(minScore));
      if (minPremium > 0) params.set('minPremium', String(minPremium));
      const res = await fetch(
        `/api/lottery-finder-ticker-counts?${params.toString()}`,
        { credentials: 'include', signal: ctrl.signal },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as LotteryFinderTickerCountsResponse;
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
  }, [date, reload, cheapCallPm, mode, optionType, tod, minScore, minPremium]);

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
