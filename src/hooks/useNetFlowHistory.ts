/**
 * useNetFlowHistory — fetches /api/net-flow-history for a ticker on
 * a date. Lazy: callers pass `enabled=false` while a row is collapsed
 * so we don't burn network on rows the user hasn't looked at.
 *
 * Polls during market hours when the date is today AND the row is
 * expanded. Historical days don't poll because the data is stable.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { POLL_INTERVALS } from '../constants/index.js';
import type {
  NetFlowHistoryResponse,
  NetFlowTick,
} from '../components/LotteryFinder/types.js';
import { getErrorMessage } from '../utils/error.js';

interface UseNetFlowHistoryArgs {
  /** Ticker — required when enabled. */
  ticker: string;
  /** YYYY-MM-DD trading day. */
  date: string;
  /** Optional HH:MM CT lower bound. */
  from?: string;
  /** Optional HH:MM CT upper bound. */
  to?: string;
  /** When false, the hook does NOT fetch (lets callers gate by row expand). */
  enabled: boolean;
  /** Whether to poll while live (today + market hours). */
  marketOpen: boolean;
}

interface State {
  series: NetFlowTick[];
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
}

const INITIAL_STATE: State = {
  series: [],
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

export function useNetFlowHistory({
  ticker,
  date,
  from,
  to,
  enabled,
  marketOpen,
}: UseNetFlowHistoryArgs): State & { refetch: () => void } {
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
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const res = await fetch(
        `/api/net-flow-history?${params.toString()}`,
        { credentials: 'include', signal: ctrl.signal },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as NetFlowHistoryResponse;

      if (ctrl.signal.aborted) return;
      setState({
        series: json.series,
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
  }, [ticker, date, from, to, enabled]);

  useEffect(() => {
    fetchOnce();
    if (!enabled) return;
    if (!marketOpen) return;
    // Only poll today's data — historical is stable.
    if (date !== todayCt()) return;
    const id = setInterval(fetchOnce, POLL_INTERVALS.OTM_FLOW);
    return () => clearInterval(id);
  }, [fetchOnce, enabled, marketOpen, date]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return useMemo(() => ({ ...state, refetch: fetchOnce }), [state, fetchOnce]);
}
