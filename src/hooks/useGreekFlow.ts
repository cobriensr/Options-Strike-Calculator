/**
 * useGreekFlow — fetches the SPY+QQQ Greek flow session from
 * /api/greek-flow with optional date scrubbing.
 *
 * Live mode (no date arg): polls /api/greek-flow every
 * POLL_INTERVALS.GREEK_FLOW during market hours.
 *
 * Date mode (date='YYYY-MM-DD'): one-shot fetch of that calendar day's
 * session (the past doesn't change — no polling).
 *
 * Owner-or-guest: matches the API endpoint's auth tier. Public visitors
 * get 401 and the hook stays idle without surfacing a user-visible error.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { POLL_INTERVALS } from '../constants';
import { getErrorMessage } from '../utils/error';
import { getAccessMode } from '../utils/auth';

// ── Types mirror the server response in api/greek-flow.ts ───────────

export type GreekFlowTicker = 'SPY' | 'QQQ';

export type GreekFlowField =
  | 'dir_vega_flow'
  | 'total_vega_flow'
  | 'otm_dir_vega_flow'
  | 'otm_total_vega_flow'
  | 'dir_delta_flow'
  | 'total_delta_flow'
  | 'otm_dir_delta_flow'
  | 'otm_total_delta_flow';

export interface GreekFlowRow {
  ticker: GreekFlowTicker;
  timestamp: string;
  transactions: number;
  volume: number;
  dir_vega_flow: number;
  total_vega_flow: number;
  otm_dir_vega_flow: number;
  otm_total_vega_flow: number;
  dir_delta_flow: number;
  total_delta_flow: number;
  otm_dir_delta_flow: number;
  otm_total_delta_flow: number;
  cum_dir_vega_flow: number;
  cum_total_vega_flow: number;
  cum_otm_dir_vega_flow: number;
  cum_otm_total_vega_flow: number;
  cum_dir_delta_flow: number;
  cum_total_delta_flow: number;
  cum_otm_dir_delta_flow: number;
  cum_otm_total_delta_flow: number;
}

export type Sign = 1 | -1 | 0;

export interface SlopeResult {
  slope: number | null;
  points: number;
}

export interface FlipResult {
  occurred: boolean;
  atTimestamp: string | null;
  magnitude: number;
  currentSign: Sign;
}

export interface CliffResult {
  magnitude: number;
  atTimestamp: string | null;
}

export interface DivergenceResult {
  spySign: Sign;
  qqqSign: Sign;
  diverging: boolean;
}

export type GreekFlowMetrics = Record<
  GreekFlowField,
  { slope: SlopeResult; flip: FlipResult; cliff: CliffResult }
>;

export interface GreekFlowResponse {
  date: string | null;
  tickers: Record<
    GreekFlowTicker,
    { rows: GreekFlowRow[]; metrics: GreekFlowMetrics }
  >;
  divergence: Record<GreekFlowField, DivergenceResult>;
  asOf: string;
}

export interface UseGreekFlowReturn {
  data: GreekFlowResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useGreekFlow(
  marketOpen: boolean,
  date: string | null = null,
): UseGreekFlowReturn {
  const accessMode = getAccessMode();
  const [data, setData] = useState<GreekFlowResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const fetchData = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (date) qs.set('date', date);
      const url = qs.toString() ? `/api/greek-flow?${qs}` : '/api/greek-flow';

      const res = await fetch(url, {
        credentials: 'same-origin',
        signal: AbortSignal.timeout(8_000),
      });

      if (!mountedRef.current) return;

      if (!res.ok) {
        // 401 for anon visitors is expected and not a user-visible error.
        if (res.status !== 401) setError('Failed to load Greek flow');
        return;
      }

      const body = (await res.json()) as GreekFlowResponse;
      if (!mountedRef.current) return;

      setData(body);
      setError(null);
    } catch (err) {
      if (mountedRef.current) setError(getErrorMessage(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (accessMode === 'public') {
      setLoading(false);
      return;
    }

    void fetchData();

    // Date-scrubbed view is static — no polling.
    if (!marketOpen || date) return;

    const id = setInterval(() => void fetchData(), POLL_INTERVALS.GREEK_FLOW);
    return () => clearInterval(id);
  }, [accessMode, marketOpen, date, fetchData]);

  const refresh = useCallback(() => {
    setLoading(true);
    void fetchData();
  }, [fetchData]);

  return { data, loading, error, refresh };
}
