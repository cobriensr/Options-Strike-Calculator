/**
 * useGexStrikeExpiry — fetches per-strike GEX for SPY + QQQ from
 * /api/gex-strike-expiry, one call per ticker, in parallel.
 *
 * Live mode (no `at` arg): polls every POLL_INTERVALS.STRIKE_BATTLE_MAP
 * during market hours. The uw-stream daemon UPSERTs WS pushes
 * continuously, so each poll picks up the latest minute snapshot.
 *
 * Snapshot mode (`at='YYYY-MM-DDTHH:mm:ssZ'`): one-shot fetch using
 * the `at` query parameter — used by the historical scrubber. No
 * polling because the past doesn't change.
 *
 * Owner-or-guest: matches the API endpoint's auth tier. Public
 * visitors get 401 and the hook stays idle without surfacing a
 * user-visible error.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { POLL_INTERVALS } from '../constants';
import { getErrorMessage } from '../utils/error';
import { getAccessMode } from '../utils/auth';

// Ticker set + row shape mirror api/_lib/db-gex-strike-expiry.ts.

export type GexStrikeExpiryTicker = 'SPY' | 'QQQ' | 'SPX' | 'NDX';

export interface GexStrikeExpiryRow {
  ticker: GexStrikeExpiryTicker;
  expiry: string;
  strike: number;
  ts_minute: string;
  price: number | null;
  call_gamma_oi: number | null;
  put_gamma_oi: number | null;
  call_charm_oi: number | null;
  put_charm_oi: number | null;
  call_vanna_oi: number | null;
  put_vanna_oi: number | null;
  call_gamma_vol: number | null;
  put_gamma_vol: number | null;
  call_charm_vol: number | null;
  put_charm_vol: number | null;
  call_vanna_vol: number | null;
  put_vanna_vol: number | null;
  call_gamma_ask_vol: number | null;
  call_gamma_bid_vol: number | null;
  put_gamma_ask_vol: number | null;
  put_gamma_bid_vol: number | null;
  call_charm_ask_vol: number | null;
  call_charm_bid_vol: number | null;
  put_charm_ask_vol: number | null;
  put_charm_bid_vol: number | null;
  call_vanna_ask_vol: number | null;
  call_vanna_bid_vol: number | null;
  put_vanna_ask_vol: number | null;
  put_vanna_bid_vol: number | null;
}

export interface GexStrikeExpiryResponse {
  ticker: GexStrikeExpiryTicker;
  expiry: string;
  at: string | null;
  rows: GexStrikeExpiryRow[];
  /**
   * Every distinct `ts_minute` value for (ticker, expiry), ascending.
   * Surfaced by the API to power scrub-control prev/next navigation in
   * the GexLandscape consumer (see useGexLandscapeData).
   */
  timestamps: string[];
  asOf: string;
}

export interface UseGexStrikeExpiryReturn {
  /** Per-ticker latest payload, or null until first successful fetch. */
  data: Record<GexStrikeExpiryTicker, GexStrikeExpiryResponse | null>;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const TICKERS: readonly GexStrikeExpiryTicker[] = [
  'SPY',
  'QQQ',
  'SPX',
  'NDX',
] as const;

function emptyData(): Record<
  GexStrikeExpiryTicker,
  GexStrikeExpiryResponse | null
> {
  return { SPY: null, QQQ: null, SPX: null, NDX: null };
}

async function fetchOne(
  ticker: GexStrikeExpiryTicker,
  expiry: string,
  at: string | null,
): Promise<GexStrikeExpiryResponse | null> {
  const qs = new URLSearchParams({ ticker, expiry });
  if (at) qs.set('at', at);
  const res = await fetch(`/api/gex-strike-expiry?${qs.toString()}`, {
    credentials: 'same-origin',
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    // 401 for anon visitors is expected and non-fatal — the hook
    // returns nulls and the section renders an empty/auth-prompt state.
    if (res.status === 401) return null;
    throw new Error(`gex-strike-expiry ${ticker}: HTTP ${res.status}`);
  }
  return (await res.json()) as GexStrikeExpiryResponse;
}

export function useGexStrikeExpiry(
  marketOpen: boolean,
  expiry: string,
  at: string | null = null,
): UseGexStrikeExpiryReturn {
  const accessMode = getAccessMode();
  const [data, setData] =
    useState<Record<GexStrikeExpiryTicker, GexStrikeExpiryResponse | null>>(
      emptyData,
    );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const fetchAll = useCallback(async () => {
    try {
      const results = await Promise.allSettled(
        TICKERS.map((t) => fetchOne(t, expiry, at)),
      );

      if (!mountedRef.current) return;

      const next = emptyData();
      let anyError = false;
      results.forEach((result, idx) => {
        const ticker = TICKERS[idx];
        if (ticker == null) return;
        if (result.status === 'fulfilled') {
          next[ticker] = result.value;
        } else {
          anyError = true;
        }
      });

      setData(next);
      setError(anyError ? 'Partial fetch failure' : null);
    } catch (err) {
      if (mountedRef.current) setError(getErrorMessage(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [expiry, at]);

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

    void fetchAll();

    // Snapshot mode is static — no polling.
    if (!marketOpen || at) return;

    const id = setInterval(
      () => void fetchAll(),
      POLL_INTERVALS.STRIKE_BATTLE_MAP,
    );
    return () => clearInterval(id);
  }, [accessMode, marketOpen, at, fetchAll]);

  const refresh = useCallback(() => {
    setLoading(true);
    void fetchAll();
  }, [fetchAll]);

  return { data, loading, error, refresh };
}
