/**
 * useDealerRegime — fetches /api/dealer-regime once on mount, then polls
 * every POLL_INTERVALS.DEALER_REGIME during market hours.
 *
 * Public visitors (no owner cookie + no guest token) hit a 401 from the
 * endpoint; the hook treats that as non-fatal — `data === null` and
 * `error === null` so the tile renders an inert placeholder instead of
 * surfacing an authentication error to anonymous viewers.
 *
 * Off-hours (or any time `marketOpen=false`): one fetch, no polling.
 * Friday's 16:00 ET row stays on the tile through the weekend; the
 * classifier flags it `uncertain` once it crosses the 15-minute
 * staleness threshold so the tile reads honest until Monday's open.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { POLL_INTERVALS } from '../constants';
import { getErrorMessage } from '../utils/error';
import { getAccessMode } from '../utils/auth';

export interface DealerRegimeRow {
  ticker: 'SPX' | 'NDX' | 'SPY' | 'QQQ';
  ts: string;
  spot: number;
  zeroGamma: number | null;
  confidence: number | null;
  netGammaAtSpot: number | null;
}

export interface DealerRegimeResponse {
  rows: DealerRegimeRow[];
  asOf: string;
}

export interface UseDealerRegimeReturn {
  data: DealerRegimeResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

async function fetchDealerRegime(): Promise<DealerRegimeResponse | null> {
  const res = await fetch('/api/dealer-regime', {
    credentials: 'same-origin',
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    // 401 for anon visitors is expected — return null and surface no error.
    if (res.status === 401) return null;
    throw new Error(`dealer-regime: HTTP ${res.status}`);
  }
  return (await res.json()) as DealerRegimeResponse;
}

export function useDealerRegime(marketOpen: boolean): UseDealerRegimeReturn {
  const accessMode = getAccessMode();
  const [data, setData] = useState<DealerRegimeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const fetchOnce = useCallback(async () => {
    try {
      const next = await fetchDealerRegime();
      if (!mountedRef.current) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (mountedRef.current) setError(getErrorMessage(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

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

    void fetchOnce();

    if (!marketOpen) return;

    const id = setInterval(
      () => void fetchOnce(),
      POLL_INTERVALS.DEALER_REGIME,
    );
    return () => clearInterval(id);
  }, [accessMode, marketOpen, fetchOnce]);

  const refresh = useCallback(() => {
    setLoading(true);
    void fetchOnce();
  }, [fetchOnce]);

  return { data, loading, error, refresh };
}
