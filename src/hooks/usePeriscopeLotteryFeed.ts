/**
 * usePeriscopeLotteryFeed — fetches /api/periscope-lottery-feed and
 * polls every 60s during market hours (matches the Periscope 10-min
 * publish cadence and the detect-cron's 5-min schedule).
 *
 * Mirrors the polling shape of useSilentBoomFeed / useLotteryFinder.
 * Historical dates are static — polling is skipped when `date` is in
 * the past so we don't churn requests for sealed days.
 *
 * Spec: docs/superpowers/specs/periscope-lottery-alerts-2026-05-19.md
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { POLL_INTERVALS } from '../constants/index.js';
import type {
  LotteryFireTypeFilter,
  PeriscopeLotteryFeedResponse,
  PeriscopeLotteryFire,
} from '../components/PeriscopeLottery/types.js';
import { getErrorMessage } from '../utils/error.js';
import { usePolling } from './usePolling.js';

interface UsePeriscopeLotteryFeedArgs {
  /** YYYY-MM-DD (ET) — `today` in the panel, can also be a historical date. */
  date: string;
  marketOpen: boolean;
  /** When true, date is in the past — skip polling. */
  historical?: boolean;
  /** 'both' (default) returns calls + puts mixed; the panel filters
   *  per-side client-side rather than making two requests. */
  fireType?: LotteryFireTypeFilter;
  /** Server clamps to [1, 500]; UI defaults to 50. */
  limit?: number;
}

interface State {
  fires: PeriscopeLotteryFire[];
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
}

const INITIAL_STATE: State = {
  fires: [],
  loading: true,
  error: null,
  fetchedAt: null,
};

export function usePeriscopeLotteryFeed({
  date,
  marketOpen,
  historical = false,
  fireType = 'both',
  limit = 50,
}: UsePeriscopeLotteryFeedArgs): State & { refresh: () => void } {
  const [state, setState] = useState<State>(INITIAL_STATE);
  const abortRef = useRef<AbortController | null>(null);

  const fetchOnce = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const params = new URLSearchParams({
        date,
        fire_type: fireType,
        limit: String(limit),
      });
      const res = await fetch(
        `/api/periscope-lottery-feed?${params.toString()}`,
        {
          credentials: 'include',
          signal: ctrl.signal,
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as PeriscopeLotteryFeedResponse;
      if (ctrl.signal.aborted) return;
      setState({
        fires: json.fires,
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
  }, [date, fireType, limit]);

  // Eager fetch on mount / arg change. usePolling only schedules the
  // recurring tick.
  useEffect(() => {
    fetchOnce();
  }, [fetchOnce]);

  usePolling(fetchOnce, POLL_INTERVALS.PERISCOPE, [marketOpen, !historical]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return useMemo(() => ({ ...state, refresh: fetchOnce }), [state, fetchOnce]);
}
