/**
 * useLotteryFinder — fetches /api/lottery-finder for a given trading
 * day and optional time-scrub cutoff. Polls every 30s during market
 * hours when scrubAt is null (live mode). When the user scrubs into
 * the past, polling stops because the response is stable.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { POLL_INTERVALS } from '../constants/index.js';
import type {
  LotteryFinderResponse,
  LotteryFire,
  LotteryMode,
} from '../components/LotteryFinder/types.js';
import { getErrorMessage } from '../utils/error.js';

interface UseLotteryFinderArgs {
  /** YYYY-MM-DD trading day. */
  date: string;
  /** Optional scrubber cutoff ISO timestamp. Null = live mode. */
  at?: string | null;
  marketOpen: boolean;
  /** Filter by ticker. `null` returns all. */
  ticker?: string | null;
  /** Filter to RE-LOAD only. */
  reload?: boolean | null;
  /** Filter to cheap-call-PM only. */
  cheapCallPm?: boolean | null;
  /** Filter by mode (Mode A or Mode B). */
  mode?: LotteryMode | null;
}

interface State {
  fires: LotteryFire[];
  loading: boolean;
  error: string | null;
  asOf: string | null;
  fetchedAt: number | null;
}

const INITIAL_STATE: State = {
  fires: [],
  loading: true,
  error: null,
  asOf: null,
  fetchedAt: null,
};

export function useLotteryFinder({
  date,
  at,
  marketOpen,
  ticker = null,
  reload = null,
  cheapCallPm = null,
  mode = null,
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
      const params = new URLSearchParams({ date });
      if (at) params.set('at', at);
      if (ticker) params.set('ticker', ticker);
      if (reload != null) params.set('reload', String(reload));
      if (cheapCallPm != null) params.set('cheapCallPm', String(cheapCallPm));
      if (mode != null) params.set('mode', mode);
      const res = await fetch(`/api/lottery-finder?${params.toString()}`, {
        credentials: 'include',
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as LotteryFinderResponse;

      setState({
        fires: json.fires,
        loading: false,
        error: null,
        asOf: json.asOf,
        fetchedAt: Date.now(),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setState((prev) => ({
        ...prev,
        loading: false,
        error: getErrorMessage(err),
      }));
    }
  }, [date, at, ticker, reload, cheapCallPm, mode]);

  // Reset state on date change so the prior day's rows don't briefly
  // flash while the new fetch is in flight.
  useEffect(() => {
    setState(INITIAL_STATE);
  }, [date]);

  useEffect(() => {
    fetchOnce();
    if (!marketOpen) return;
    // No polling when scrubbed into the past — historical fires don't
    // change, so polling is wasted CPU + bandwidth.
    if (at) return;
    const id = setInterval(fetchOnce, POLL_INTERVALS.OTM_FLOW);
    return () => clearInterval(id);
  }, [fetchOnce, marketOpen, at]);

  // Cancel any in-flight request on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  return useMemo(
    () => ({ ...state, refetch: fetchOnce }),
    [state, fetchOnce],
  );
}
