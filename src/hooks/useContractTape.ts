/**
 * useContractTape — fetches /api/lottery-contract-tape for an OCC
 * chain on a date. Lazy: callers pass `enabled=false` while a row is
 * collapsed so we don't burn network on rows the user hasn't expanded.
 *
 * Polls during market hours when the date is today AND the row is
 * expanded. Historical days don't poll because the data is stable.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { POLL_INTERVALS } from '../constants/index.js';
import type {
  ContractTapeBar,
  ContractTapeResponse,
} from '../components/LotteryFinder/types.js';
import { getErrorMessage } from '../utils/error.js';

interface UseContractTapeArgs {
  /** OCC OSI symbol — required when enabled. */
  chain: string;
  /** YYYY-MM-DD trading day. */
  date: string;
  /** Optional HH:MM CT lower bound. */
  from?: string;
  /** Optional HH:MM CT upper bound. */
  to?: string;
  /** When false, the hook does NOT fetch. */
  enabled: boolean;
  /** Whether to poll while live (today + market hours). */
  marketOpen: boolean;
}

interface State {
  series: ContractTapeBar[];
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

export function useContractTape({
  chain,
  date,
  from,
  to,
  enabled,
  marketOpen,
}: UseContractTapeArgs): State & { refetch: () => void } {
  const [state, setState] = useState<State>(INITIAL_STATE);
  const abortRef = useRef<AbortController | null>(null);

  const fetchOnce = useCallback(async () => {
    if (!enabled) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const params = new URLSearchParams({ chain, date });
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const res = await fetch(
        `/api/lottery-contract-tape?${params.toString()}`,
        { credentials: 'include', signal: ctrl.signal },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as ContractTapeResponse;

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
  }, [chain, date, from, to, enabled]);

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
