/**
 * useZeroGamma — fetches zero-gamma data for one ticker, optionally
 * scoped to a specific calendar date for historical scrubbing.
 *
 * Live mode (no date arg): polls /api/zero-gamma?ticker=X every
 * POLL_INTERVALS.ZERO_GAMMA during market hours. Returns the latest
 * snapshot plus the most recent 100 rows.
 *
 * Date mode (date='YYYY-MM-DD'): one-shot fetch of all snapshots for
 * that calendar day (no polling — the past doesn't change). `latest`
 * is the last snapshot of the day.
 *
 * Owner-or-guest: matches the API endpoint's auth tier
 * (guardOwnerOrGuestEndpoint). Public visitors get 401 and the hook
 * stays idle.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { POLL_INTERVALS } from '../constants';
import { getErrorMessage } from '../utils/error';
import { getAccessMode } from '../utils/auth';

export interface ZeroGammaRow {
  ticker: string;
  spot: number;
  zeroGamma: number | null;
  confidence: number | null;
  netGammaAtSpot: number | null;
  gammaCurve: unknown;
  ts: string;
}

export interface UseZeroGammaReturn {
  latest: ZeroGammaRow | null;
  history: ZeroGammaRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

interface ApiResponse {
  latest: ZeroGammaRow | null;
  history: ZeroGammaRow[];
}

export function useZeroGamma(
  ticker: string,
  marketOpen: boolean,
  date: string | null = null,
): UseZeroGammaReturn {
  const accessMode = getAccessMode();
  const [latest, setLatest] = useState<ZeroGammaRow | null>(null);
  const [history, setHistory] = useState<ZeroGammaRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const fetchData = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ ticker });
      if (date) qs.set('date', date);
      const res = await fetch(`/api/zero-gamma?${qs}`, {
        credentials: 'same-origin',
        signal: AbortSignal.timeout(5_000),
      });

      if (!mountedRef.current) return;

      if (!res.ok) {
        // 401 for anon visitors is expected and not a user-visible error.
        if (res.status !== 401) setError('Failed to load zero-gamma data');
        return;
      }

      const data = (await res.json()) as ApiResponse;
      if (!mountedRef.current) return;

      setLatest(data.latest);
      setHistory(data.history);
      setError(null);
    } catch (err) {
      if (mountedRef.current) setError(getErrorMessage(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [ticker, date]);

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

    // Date-scrubbed view is static (the past doesn't change) — no polling.
    if (!marketOpen || date) return;

    const id = setInterval(() => void fetchData(), POLL_INTERVALS.ZERO_GAMMA);
    return () => clearInterval(id);
  }, [accessMode, marketOpen, date, fetchData]);

  const refresh = useCallback(() => {
    setLoading(true);
    void fetchData();
  }, [fetchData]);

  return { latest, history, loading, error, refresh };
}
