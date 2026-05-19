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
  ticker: 'SPX' | 'SPY' | 'QQQ';
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
  signal: AbortSignal,
): Promise<DealerRegimeResponse | null> {
  const qs = new URLSearchParams();
  if (date) qs.set('date', date);
  if (at) qs.set('at', at);
  const url = qs.toString()
    ? `/api/dealer-regime?${qs.toString()}`
    : '/api/dealer-regime';
  const res = await fetch(url, {
    credentials: 'same-origin',
    signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
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
  // Cancels any in-flight request on rerun / unmount so a stale response
  // can't clobber a newer fetch's state and the browser stops the
  // bandwidth burn on rapid date/at changes.
  const abortRef = useRef<AbortController | null>(null);

  const fetchOnce = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const next = await fetchDealerRegime(date, at, ctrl.signal);
      if (!mountedRef.current) return;
      // Superseded by a newer fetch between resolve and parse — bail.
      if (ctrl.signal.aborted) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (ctrl.signal.aborted) return;
      if (mountedRef.current) setError(getErrorMessage(err));
    } finally {
      // Only clear loading if this fetch wasn't superseded — a newer
      // fetch owns loading=true until it itself resolves.
      if (mountedRef.current && abortRef.current === ctrl) setLoading(false);
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

  // Cancel any in-flight request on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  return { data, loading, error, refresh };
}
