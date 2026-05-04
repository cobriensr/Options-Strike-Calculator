/**
 * useDealerRegime — fetches /api/dealer-regime once on mount, then polls
 * every POLL_INTERVALS.DEALER_REGIME during market hours.
 *
 * Live mode (no `date` / no `at`): polls during market hours, picks up
 * fresh rows as the compute-zero-gamma cron writes them.
 *
 * Snapshot mode (`date` and/or `at`): one-shot fetch, no polling — the
 * past doesn't change. Used by the historical scrubber.
 *
 * Public visitors (no owner cookie + no guest token) hit a 401 from the
 * endpoint; the hook treats that as non-fatal — `data === null` and
 * `error === null` so the tile renders an inert placeholder instead of
 * surfacing an authentication error to anonymous viewers.
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
  date: string | null;
  at: string | null;
  rows: DealerRegimeRow[];
  asOf: string;
}

export interface UseDealerRegimeReturn {
  data: DealerRegimeResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

async function fetchDealerRegime(
  date: string | null,
  at: string | null,
): Promise<DealerRegimeResponse | null> {
  const qs = new URLSearchParams();
  if (date) qs.set('date', date);
  if (at) qs.set('at', at);
  const url = qs.toString()
    ? `/api/dealer-regime?${qs.toString()}`
    : '/api/dealer-regime';
  const res = await fetch(url, {
    credentials: 'same-origin',
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    if (res.status === 401) return null;
    throw new Error(`dealer-regime: HTTP ${res.status}`);
  }
  return (await res.json()) as DealerRegimeResponse;
}

export function useDealerRegime(
  marketOpen: boolean,
  date: string | null = null,
  at: string | null = null,
): UseDealerRegimeReturn {
  const accessMode = getAccessMode();
  const [data, setData] = useState<DealerRegimeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const fetchOnce = useCallback(async () => {
    try {
      const next = await fetchDealerRegime(date, at);
      if (!mountedRef.current) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (mountedRef.current) setError(getErrorMessage(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [date, at]);

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

    // Snapshot mode (date or at set) is static — no polling.
    if (!marketOpen || date || at) return;

    const id = setInterval(
      () => void fetchOnce(),
      POLL_INTERVALS.DEALER_REGIME,
    );
    return () => clearInterval(id);
  }, [accessMode, marketOpen, date, at, fetchOnce]);

  const refresh = useCallback(() => {
    setLoading(true);
    void fetchOnce();
  }, [fetchOnce]);

  return { data, loading, error, refresh };
}
