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
import * as Sentry from '@sentry/react';
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
  /**
   * Per-strike Δ% over the 1/5/10/15/30m windows, computed server-side
   * via SQL `LAG()` over `ws_gex_strike_expiry.ts_minute`. Values are
   * percent (e.g. `5` for +5%), matching the legacy client-side
   * `computeDeltaMap` convention. `null` when no comparable prior row
   * exists inside the lookback window.
   */
  gamma_delta_1m: number | null;
  gamma_delta_5m: number | null;
  gamma_delta_10m: number | null;
  gamma_delta_15m: number | null;
  gamma_delta_30m: number | null;
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
  /**
   * Summary error string, or `null` when every ticker fetch succeeded.
   * Names the failed tickers so the UI can localize the cause without
   * having to dig into `errors`. Format: `'Partial fetch failure: SPX'`
   * (single) or `'Partial fetch failure: SPX, NDX'` (multiple).
   */
  error: string | null;
  /**
   * Per-ticker error, or `null` when that ticker's fetch succeeded.
   * Lets per-ticker consumers (GexLandscape) render a tab-scoped error
   * instead of the global "Partial fetch failure" — so SPX no longer
   * shows a red banner when only NDX failed.
   */
  errors: Record<GexStrikeExpiryTicker, string | null>;
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

function emptyErrors(): Record<GexStrikeExpiryTicker, string | null> {
  return { SPY: null, QQQ: null, SPX: null, NDX: null };
}

function emptyFailCounts(): Record<GexStrikeExpiryTicker, number> {
  return { SPY: 0, QQQ: 0, SPX: 0, NDX: 0 };
}

// Per-fetch timeout. 30s covers ~p95 of API latency after the server
// added a 6s per-attempt SQL ceiling + retry (see api/_lib/db.ts
// withDbRetry). 8s was too tight when Neon's serverless HTTP path
// hit intermittent cold-connection hangs — produced 50%+ user-visible
// failures even though the SQL itself ran in ~230ms.
const FETCH_TIMEOUT_MS = 30_000;

// Don't surface a transient single-poll miss as an error. The GEX
// Landscape polls every 30s; one timeout is invisible noise the user
// shouldn't see flashed as a red banner. The 2nd consecutive failure
// means real degradation worth showing.
const FAIL_GRACE_COUNT = 2;

async function fetchOne(
  ticker: GexStrikeExpiryTicker,
  expiry: string,
  at: string | null,
): Promise<GexStrikeExpiryResponse | null> {
  const qs = new URLSearchParams({ ticker, expiry });
  if (at) qs.set('at', at);
  const res = await fetch(`/api/gex-strike-expiry?${qs.toString()}`, {
    credentials: 'same-origin',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
  const [errors, setErrors] =
    useState<Record<GexStrikeExpiryTicker, string | null>>(emptyErrors);
  const mountedRef = useRef(true);

  // Per-ticker consecutive-failure counter. Only surfaces an error once
  // the same ticker fails FAIL_GRACE_COUNT polls in a row, so a single
  // transient Neon hang doesn't flash a red banner on the user.
  const failsRef =
    useRef<Record<GexStrikeExpiryTicker, number>>(emptyFailCounts());

  const fetchAll = useCallback(async () => {
    try {
      const results = await Promise.allSettled(
        TICKERS.map((t) => fetchOne(t, expiry, at)),
      );

      if (!mountedRef.current) return;

      const next = emptyData();
      const nextErrors = emptyErrors();
      const erroredTickers: GexStrikeExpiryTicker[] = [];
      results.forEach((result, idx) => {
        const ticker = TICKERS[idx];
        if (ticker == null) return;
        if (result.status === 'fulfilled') {
          next[ticker] = result.value;
          failsRef.current[ticker] = 0;
        } else {
          failsRef.current[ticker] += 1;
          if (failsRef.current[ticker] >= FAIL_GRACE_COUNT) {
            erroredTickers.push(ticker);
            nextErrors[ticker] = getErrorMessage(result.reason);
          }
        }
      });

      // Merge: keep the previous payload for tickers we just failed
      // on so the user sees stale-but-rendered data instead of empties.
      setData((prev) => {
        const merged = { ...prev };
        for (const t of TICKERS) {
          const r = next[t];
          if (r !== null || failsRef.current[t] === 0) merged[t] = r;
        }
        return merged;
      });
      setErrors(nextErrors);
      setError(
        erroredTickers.length > 0
          ? `Partial fetch failure: ${erroredTickers.join(', ')}`
          : null,
      );
    } catch (err) {
      // Filter expected abort path; everything else is operator-visible.
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        Sentry.captureException(err, {
          tags: { context: 'gex_strike_expiry_outer' },
        });
      }
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

  return { data, loading, error, errors, refresh };
}

export interface UseGexStrikeExpirySpxReturn {
  /** SPX-only payload, or null until first successful fetch / 401 / empty. */
  data: GexStrikeExpiryResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * SPX-only sibling of `useGexStrikeExpiry`. Fires a single
 * /api/gex-strike-expiry?ticker=SPX request per poll instead of
 * fanning out to all four tickers. Used by GexLandscape after the
 * MM-data swap (Phase 2 of
 * docs/superpowers/specs/gex-landscape-mm-swap-2026-05-12.md), which
 * only consumes SPX for the vol reinforcement side channel — fetching
 * SPY/QQQ/NDX every 30s would be ~75% wasted bandwidth.
 *
 * StrikeBattleMap continues to use the multi-ticker `useGexStrikeExpiry`
 * — that's the other consumer that genuinely needs the full Record.
 */
export function useGexStrikeExpirySpx(
  marketOpen: boolean,
  expiry: string,
  at: string | null = null,
): UseGexStrikeExpirySpxReturn {
  const accessMode = getAccessMode();
  const [data, setData] = useState<GexStrikeExpiryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  // Consecutive failure counter — only surface an error once SPX has
  // missed FAIL_GRACE_COUNT polls in a row. Single-poll Neon hangs
  // shouldn't render the "SPX vol reinforcement: signal timed out"
  // banner; the previous payload (data state) stays sticky meanwhile.
  const failCountRef = useRef(0);

  const fetchSpx = useCallback(async () => {
    try {
      const result = await fetchOne('SPX', expiry, at);
      if (!mountedRef.current) return;
      // Sticky-on-empty: preserve the prior payload when the server
      // returned null (401 anon path) so the panel doesn't blank out.
      if (result !== null) setData(result);
      failCountRef.current = 0;
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      failCountRef.current += 1;
      if (failCountRef.current >= FAIL_GRACE_COUNT) {
        setError(getErrorMessage(err));
      }
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
    void fetchSpx();
    if (!marketOpen || at) return;
    const id = setInterval(
      () => void fetchSpx(),
      POLL_INTERVALS.STRIKE_BATTLE_MAP,
    );
    return () => clearInterval(id);
  }, [accessMode, marketOpen, at, fetchSpx]);

  const refresh = useCallback(() => {
    setLoading(true);
    void fetchSpx();
  }, [fetchSpx]);

  return { data, loading, error, refresh };
}
