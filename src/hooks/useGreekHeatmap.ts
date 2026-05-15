/**
 * Polling hook for the per-ticker 0DTE Greek heatmap.
 *
 * Fetches `/api/greek-heatmap?ticker=X` on a 30s timer when both the
 * market is open AND the consumer says it's enabled (e.g. the section
 * is expanded). Outside those conditions, the hook does a single fetch
 * on mount/arg change and stops.
 *
 * Mirrors the AbortController + setInterval + cleanup pattern used by
 * `useLotteryFinder` so polling is cancel-safe across rapid ticker
 * switches.
 *
 * See docs/superpowers/specs/per-ticker-greek-heatmap-2026-05-15.md
 * Phase 4 + the `/api/greek-heatmap` endpoint contract.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { fetchWithRetry } from '../utils/fetchWithRetry';

const POLL_INTERVAL_MS = 30_000;

export interface GreekHeatmapTopStrike {
  strike: number;
  callGammaOi: number | null;
  putGammaOi: number | null;
  netGamma: number;
  callCharmOi: number | null;
  putCharmOi: number | null;
  netCharm: number;
  callVannaOi: number | null;
  putVannaOi: number | null;
  netVanna: number;
}

export interface GreekHeatmapNetFlow {
  cumulativeCallPrem: number;
  cumulativeCallVol: number;
  cumulativePutPrem: number;
  cumulativePutVol: number;
  asOf: string;
}

export interface GreekHeatmapResponse {
  ticker: string;
  date: string;
  asOf: string | null;
  underlyingPrice: number | null;
  atmStrike: number | null;
  regime: 'Long Γ' | 'Short Γ' | null;
  netGexK: number | null;
  chainStrikes: GreekHeatmapTopStrike[];
  topStrikes: GreekHeatmapTopStrike[];
  netFlow: GreekHeatmapNetFlow | null;
}

interface UseGreekHeatmapArgs {
  ticker: string;
  /**
   * Optional historical date (YYYY-MM-DD). Defaults to today on the
   * server side. Must fall within the 90-day backfill window.
   */
  date?: string;
  /**
   * When false, the hook fetches once on arg change but stops polling.
   * Typical usage: pass `marketOpen && sectionExpanded && viewingToday`.
   */
  enabled: boolean;
}

interface State {
  data: GreekHeatmapResponse | null;
  loading: boolean;
  error: string | null;
}

const INITIAL_STATE: State = { data: null, loading: true, error: null };

export function useGreekHeatmap({
  ticker,
  date,
  enabled,
}: UseGreekHeatmapArgs): State & {
  refetch: () => void;
} {
  const [state, setState] = useState<State>(INITIAL_STATE);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  // Track unmount so the catch block can distinguish "aborted because
  // the component is gone" (silent return is correct) from "aborted
  // because the parent re-rendered and a new fetch is starting"
  // (must clear loading so the next fetch's setState can land cleanly).
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchOnce = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setState((s) => ({ ...s, loading: true }));
    try {
      const params = new URLSearchParams({ ticker });
      if (date) params.set('date', date);
      const res = await fetchWithRetry(`/api/greek-heatmap?${params}`, {
        credentials: 'include',
        signal: ctrl.signal,
        maxRetries: 2,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as GreekHeatmapResponse;
      if (ctrl.signal.aborted) return;
      setState({ data: json, loading: false, error: null });
    } catch (err) {
      // AbortError on a still-mounted component means the parent
      // triggered a new fetch (rapid ticker/date switch); the new
      // fetch will set loading=false when it lands, so we can safely
      // ignore this abort. On unmount, also safely ignore — there's
      // no UI left to update. The previous version silently returned
      // in BOTH cases which, paired with React StrictMode's intentional
      // double-mount, occasionally left `loading: true` stuck on the
      // first mount's state until the second mount's fetch eventually
      // overwrote it.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (ctrl.signal.aborted) return;
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : 'unknown fetch error';
      setState({ data: null, loading: false, error: msg });
    }
  }, [ticker, date]);

  useEffect(() => {
    fetchOnce();
    if (!enabled) return;
    const id = setInterval(fetchOnce, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchOnce, enabled]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return useMemo(() => ({ ...state, refetch: fetchOnce }), [state, fetchOnce]);
}
