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

      // First fetch: seed the store's dedupe set so subsequent pushes for
      // already-rendered whales become no-ops. Subsequent fetches: push
      // every live whale; the store's seen Set handles dedupe centrally.
      if (primingRef.current) {
        for (const w of json.whales) whaleBannerStore.markSeen(w.id);
        primingRef.current = false;
      } else {
        for (const w of json.whales) {
          if (w.source === 'live') whaleBannerStore.push(w);
        }
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
  // The store's seen Set is intentionally module-scoped and never reset —
  // dismissed banners stay dismissed across date changes.
  useEffect(() => {
    primingRef.current = true;
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
