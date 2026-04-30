/**
 * useWhaleAnomalies — fetches /api/whale-anomalies for a given date and
 * optional time-scrub cutoff, and pushes new live whales to the banner
 * store.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { POLL_INTERVALS } from '../constants/index.js';
import { whaleBannerStore } from '../components/WhaleAnomalies/banner-store.js';
import type {
  WhaleAnomaliesResponse,
  WhaleAnomaly,
} from '../components/WhaleAnomalies/types.js';
import { getErrorMessage } from '../utils/error.js';

interface UseWhaleAnomaliesArgs {
  date: string;
  /** Optional cutoff ISO timestamp — shows only whales with first_ts ≤ at. */
  at?: string | null;
  marketOpen: boolean;
  /** Filter by ticker. `null` returns all. */
  ticker?: string | null;
}

interface State {
  whales: WhaleAnomaly[];
  loading: boolean;
  error: string | null;
  asOf: string | null;
  fetchedAt: number | null;
}

const INITIAL_STATE: State = {
  whales: [],
  loading: true,
  error: null,
  asOf: null,
  fetchedAt: null,
};

export function useWhaleAnomalies({
  date,
  at,
  marketOpen,
  ticker = null,
}: UseWhaleAnomaliesArgs): State & { refetch: () => void } {
  const [state, setState] = useState<State>(INITIAL_STATE);
  const seenRef = useRef<Set<number>>(new Set());
  const primingRef = useRef(true);

  const fetchOnce = useCallback(async () => {
    try {
      const params = new URLSearchParams({ date });
      if (at) params.set('at', at);
      if (ticker) params.set('ticker', ticker);
      const res = await fetch(`/api/whale-anomalies?${params.toString()}`, {
        credentials: 'include',
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as WhaleAnomaliesResponse;

      // Push new live whales to the banner store (skip on the first fetch
      // so existing whales don't all toast at once).
      if (!primingRef.current) {
        for (const w of json.whales) {
          if (w.source === 'live' && !seenRef.current.has(w.id)) {
            whaleBannerStore.push(w);
          }
          seenRef.current.add(w.id);
        }
      } else {
        for (const w of json.whales) seenRef.current.add(w.id);
        primingRef.current = false;
      }

      setState({
        whales: json.whales,
        loading: false,
        error: null,
        asOf: json.asOf,
        fetchedAt: Date.now(),
      });
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: getErrorMessage(err),
      }));
    }
  }, [date, at, ticker]);

  // Reset priming when date changes (back-scrubbing to a prior day).
  useEffect(() => {
    primingRef.current = true;
    seenRef.current = new Set();
    setState(INITIAL_STATE);
  }, [date]);

  // Initial fetch + poll.
  useEffect(() => {
    fetchOnce();
    if (!marketOpen) return;
    // Don't poll when scrubbing into the past.
    if (at) return;
    const id = setInterval(() => {
      fetchOnce();
    }, POLL_INTERVALS.CHAIN);
    return () => clearInterval(id);
  }, [fetchOnce, marketOpen, at]);

  const memo = useMemo(
    () => ({
      ...state,
      refetch: fetchOnce,
    }),
    [state, fetchOnce],
  );

  return memo;
}
