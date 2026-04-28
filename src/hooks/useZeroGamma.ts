/**
 * useZeroGamma — polls /api/zero-gamma?ticker=X every 60 seconds during
 * market hours. Returns the latest zero-gamma snapshot plus the most recent
 * 100 history rows for trend display.
 *
 * Owner-or-guest: matches the API endpoint's auth tier
 * (guardOwnerOrGuestEndpoint). Public visitors get 401 and the hook stays
 * idle.
 *
 * Effect dispatch:
 *   - Public            → no fetch
 *   - Market open       → fetch + poll every POLL_INTERVALS.ZERO_GAMMA
 *   - Market closed     → one-shot fetch (last value of the day)
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
): UseZeroGammaReturn {
  const accessMode = getAccessMode();
  const [latest, setLatest] = useState<ZeroGammaRow | null>(null);
  const [history, setHistory] = useState<ZeroGammaRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/zero-gamma?ticker=${ticker}`, {
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
  }, [ticker]);

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

    if (!marketOpen) return;

    const id = setInterval(() => void fetchData(), POLL_INTERVALS.ZERO_GAMMA);
    return () => clearInterval(id);
  }, [accessMode, marketOpen, fetchData]);

  const refresh = useCallback(() => {
    setLoading(true);
    void fetchData();
  }, [fetchData]);

  return { latest, history, loading, error, refresh };
}
