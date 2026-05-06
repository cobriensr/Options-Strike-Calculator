/**
 * useTickerCandles — fetches /api/ticker-candles for an underlying
 * on a date. Lazy: callers pass `enabled=false` while a row is
 * collapsed so we don't burn network on rows the user hasn't
 * looked at.
 *
 * Polls during market hours when the date is today AND the row is
 * expanded. Historical days don't poll because the data is stable.
 *
 * Mirrors useNetFlowHistory's lazy + market-hours-gated pattern so
 * the two requests sourced from a single LotteryRow expand stay in
 * lockstep.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { POLL_INTERVALS } from '../constants/index.js';
import type {
  TickerCandle,
  TickerCandlesResponse,
} from '../components/LotteryFinder/types.js';
import { getErrorMessage } from '../utils/error.js';

interface UseTickerCandlesArgs {
  /** Ticker — required when enabled. */
  ticker: string;
  /** YYYY-MM-DD trading day. */
  date: string;
  /** When false, the hook does NOT fetch. */
  enabled: boolean;
  /** Whether to poll while live (today + market hours). */
  marketOpen: boolean;
}

interface State {
  candles: TickerCandle[];
  previousClose: number | null;
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
}

const INITIAL_STATE: State = {
  candles: [],
  previousClose: null,
  loading: false,
  error: null,
  fetchedAt: null,
};

const todayCt = (): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

export function useTickerCandles({
  ticker,
  date,
  enabled,
  marketOpen,
}: UseTickerCandlesArgs): State & { refetch: () => void } {
  const [state, setState] = useState<State>(INITIAL_STATE);
  const abortRef = useRef<AbortController | null>(null);

  const fetchOnce = useCallback(async () => {
    if (!enabled) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const params = new URLSearchParams({ ticker, date });
      const res = await fetch(`/api/ticker-candles?${params.toString()}`, {
        credentials: 'include',
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as TickerCandlesResponse;

      if (ctrl.signal.aborted) return;
      setState({
        candles: json.candles,
        previousClose: json.previousClose ?? null,
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
  }, [ticker, date, enabled]);

  useEffect(() => {
    fetchOnce();
    if (!enabled) return;
    if (!marketOpen) return;
    if (date !== todayCt()) return;
    const id = setInterval(fetchOnce, POLL_INTERVALS.OTM_FLOW);
    return () => clearInterval(id);
  }, [fetchOnce, enabled, marketOpen, date]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return useMemo(() => ({ ...state, refetch: fetchOnce }), [state, fetchOnce]);
}
