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
  topStrikes: GreekHeatmapTopStrike[];
  netFlow: GreekHeatmapNetFlow | null;
}

interface UseGreekHeatmapArgs {
  ticker: string;
  /**
   * When false, the hook fetches once on arg change but stops polling.
   * Typical usage: pass `marketOpen && sectionExpanded`.
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
  enabled,
}: UseGreekHeatmapArgs): State & {
  refetch: () => void;
} {
  const [state, setState] = useState<State>(INITIAL_STATE);
  const abortRef = useRef<AbortController | null>(null);

  const fetchOnce = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setState((s) => ({ ...s, loading: true }));
    try {
      const res = await fetchWithRetry(
        `/api/greek-heatmap?ticker=${encodeURIComponent(ticker)}`,
        { credentials: 'include', signal: ctrl.signal, maxRetries: 2 },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as GreekHeatmapResponse;
      if (ctrl.signal.aborted) return;
      setState({ data: json, loading: false, error: null });
    } catch (err) {
      // Swallow expected cancellations cleanly — a rapid ticker switch
      // aborts the in-flight request and would otherwise surface as a
      // spurious "AbortError" in the UI. Mirrors useLotteryFinder.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (ctrl.signal.aborted) return;
      const msg = err instanceof Error ? err.message : 'unknown fetch error';
      setState({ data: null, loading: false, error: msg });
    }
  }, [ticker]);

  useEffect(() => {
    fetchOnce();
    if (!enabled) return;
    const id = setInterval(fetchOnce, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchOnce, enabled]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return useMemo(() => ({ ...state, refetch: fetchOnce }), [state, fetchOnce]);
}
