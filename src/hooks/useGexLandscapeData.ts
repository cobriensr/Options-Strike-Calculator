/**
 * useGexLandscapeData — fetches the per-strike GEX landscape from the
 * 1-min GexBot-fed `/api/gex-landscape` endpoint and projects each row
 * into the `GexStrikeLevel` shape the GexLandscape renderer consumes.
 *
 * Phase 4 of the GEX Landscape 1-min GexBot rebuild
 * (docs/superpowers/specs/gex-landscape-1min-gexbot-rebuild-2026-05-26.md).
 *
 * The hook owns three responsibilities:
 *   1. Single-source fetch against `/api/gex-landscape` (no WS, no MM
 *      periscope fallback).
 *   2. Build the 1m / 5m / 10m Δ% maps inline from each row's `prevNm`
 *      fields — gated by `DELTA_NOISE_FLOOR` so near-zero priors don't
 *      poison the table or the BiasPanel mean.
 *   3. Compute the per-strike vol-reinforcement classification during
 *      the same map-build pass — never recompute deltas downstream.
 *      See `computeVolReinforcement` for the agreement rule (Locked
 *      Decision #1 of the spec).
 *
 * Polling: live mode polls every POLL_INTERVALS.PERISCOPE (60s) while
 * `marketOpen` is true and we're not pinned to a scrubbed `at`.
 * Snapshot mode (`at` set) is one-shot.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { POLL_INTERVALS } from '../constants';
import { getAccessMode } from '../utils/auth';
import { getErrorMessage } from '../utils/error';
import { usePolling } from './usePolling';
import { computeVolReinforcement } from '../components/GexLandscape/classify';
import type { GexStrikeLevel } from '../components/GexLandscape/types';

/** Shape of a single strike row returned by /api/gex-landscape. */
export interface GexLandscapeStrikeRow {
  strike: number;
  gamma: number;
  charm: number;
  vanna: number;
  gammaPrev1m: number | null;
  gammaPrev5m: number | null;
  gammaPrev10m: number | null;
  charmPrev1m: number | null;
  charmPrev5m: number | null;
  charmPrev10m: number | null;
  vannaPrev1m: number | null;
  vannaPrev5m: number | null;
  vannaPrev10m: number | null;
}

/** Top-level /api/gex-landscape response. `data: null` when stale/missing. */
export interface GexLandscapeResponse {
  marketOpen: boolean;
  asOf: string;
  data: { strikes: GexLandscapeStrikeRow[]; spot: number } | null;
  reason?: 'no_slot' | 'no_spot';
  ageSec?: number;
  availableMinutes: string[];
}

export interface UseGexLandscapeDataReturn {
  strikes: GexStrikeLevel[];
  timestamps: string[];
  /** Δ% maps populated from the per-row `prevNm` fields. */
  gexDelta1mMap: Map<number, number | null>;
  gexDelta5mMap: Map<number, number | null>;
  gexDelta10mMap: Map<number, number | null>;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Magnitude floor for the Δ% denominator. Strikes whose prior gamma
 * magnitude is below this floor produce huge meaningless percentages
 * (a +5 strike against a 0.1 prior reads 5,000% Δ); the floor maps
 * those to `null` so the BiasPanel mean and the StrikeTable cells
 * don't get poisoned.
 *
 * Calibrated 2026-05-26 against 24h of `gexbot_api_capture` SPX data:
 *   - p10 within ±50pt display window: 21.5
 *   - p25 within ±50pt display window: 66.9
 *   - p50 within ±50pt display window: 250.3
 * Setting the floor at 50 mutes the bottom ~20% of in-window strikes
 * (the noise source) while passing the median and above unscathed.
 * Half the legacy MM-scale floor of 100, matching the magnitude drop
 * from MM-attributed dealer math to GexBot's per-strike attribution.
 */
const DELTA_NOISE_FLOOR = 50;

/** Pure: compute one strike's Δ% against its own prev value. */
function computeDelta(current: number, prev: number | null): number | null {
  if (prev == null || Math.abs(prev) < DELTA_NOISE_FLOOR) return null;
  return ((current - prev) / Math.abs(prev)) * 100;
}

/**
 * Project an endpoint strike row into the `GexStrikeLevel` shape the
 * GexLandscape renderer consumes.
 *
 * - Endpoint `gamma` → `netGamma`, `charm` → `netCharm`, `vanna` → `netVanna`.
 *   The endpoint already serves MM-attributed values from GexBot.
 * - `price` ← top-level `spot` from the endpoint payload.
 * - All call/put split fields stay zero — WS side channel is gone and
 *   MM dealer math collapses call/put attribution anyway.
 * - `volReinforcement` is computed from the row's three pre-computed
 *   deltas via `computeVolReinforcement` (delta-trend agreement per
 *   Locked Decision #1). Caller supplies the three Δ% values so the
 *   hook doesn't have to recompute them.
 */
export function projectStrike(
  row: GexLandscapeStrikeRow,
  spot: number,
  delta1m: number | null,
  delta5m: number | null,
  delta10m: number | null,
): GexStrikeLevel {
  const volReinforcement = computeVolReinforcement({
    netGamma: row.gamma,
    delta1m,
    delta5m,
    delta10m,
  });
  return {
    strike: row.strike,
    price: spot,
    callGammaOi: 0,
    putGammaOi: 0,
    netGamma: row.gamma,
    callGammaVol: 0,
    putGammaVol: 0,
    netGammaVol: 0,
    volReinforcement,
    callGammaAsk: 0,
    callGammaBid: 0,
    putGammaAsk: 0,
    putGammaBid: 0,
    callCharmOi: 0,
    putCharmOi: 0,
    netCharm: row.charm,
    callCharmVol: 0,
    putCharmVol: 0,
    netCharmVol: 0,
    callDeltaOi: 0,
    putDeltaOi: 0,
    netDelta: 0,
    callVannaOi: 0,
    putVannaOi: 0,
    netVanna: row.vanna,
    callVannaVol: 0,
    putVannaVol: 0,
    netVannaVol: 0,
  };
}

async function fetchGexLandscape(
  at: string | null,
  signal: AbortSignal,
): Promise<GexLandscapeResponse | null> {
  const qs = new URLSearchParams();
  if (at != null) qs.set('at', at);
  const url = qs.toString()
    ? `/api/gex-landscape?${qs.toString()}`
    : '/api/gex-landscape';
  const res = await fetch(url, {
    credentials: 'same-origin',
    signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
  });
  if (!res.ok) {
    if (res.status === 401) return null;
    throw new Error(`gex-landscape: HTTP ${res.status}`);
  }
  return (await res.json()) as GexLandscapeResponse;
}

export function useGexLandscapeData(
  marketOpen: boolean,
  // `_expiry` kept on the signature for component-call-site compat
  // (Phase 4 drops it). /api/gex-landscape resolves the expiry
  // server-side from `getETDateStr(new Date())` since 0DTE-only.
  _expiry: string,
  at: string | null = null,
): UseGexLandscapeDataReturn {
  const accessMode = getAccessMode();
  const [resp, setResp] = useState<GexLandscapeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);

  const fetchOnce = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const next = await fetchGexLandscape(at, ctrl.signal);
      if (!mountedRef.current || ctrl.signal.aborted) return;
      setResp(next);
      setError(null);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (ctrl.signal.aborted) return;
      if (mountedRef.current) setError(getErrorMessage(err));
    } finally {
      if (mountedRef.current && abortRef.current === ctrl) setLoading(false);
    }
  }, [at]);

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
  }, [accessMode, fetchOnce]);

  // Snapshot mode (`at` set) is static — no polling. Public access stays idle.
  usePolling(() => void fetchOnce(), POLL_INTERVALS.PERISCOPE, [
    accessMode !== 'public',
    marketOpen,
    !at,
  ]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const refresh = useCallback(() => {
    setLoading(true);
    void fetchOnce();
  }, [fetchOnce]);

  // Derived state — kept inline (no `useMemo`) because the dep is a
  // single `resp` reference and the work is O(N strikes), N≈40.
  //
  // The deltas are computed once per row and threaded into `projectStrike`
  // so vol-reinforcement uses the SAME values that populate the maps —
  // never recompute downstream.
  const sourceRows = resp?.data?.strikes ?? [];
  const spot = resp?.data?.spot ?? 0;

  const gexDelta1mMap = new Map<number, number | null>();
  const gexDelta5mMap = new Map<number, number | null>();
  const gexDelta10mMap = new Map<number, number | null>();
  const strikes: GexStrikeLevel[] = [];
  for (const row of sourceRows) {
    const d1 = computeDelta(row.gamma, row.gammaPrev1m);
    const d5 = computeDelta(row.gamma, row.gammaPrev5m);
    const d10 = computeDelta(row.gamma, row.gammaPrev10m);
    gexDelta1mMap.set(row.strike, d1);
    gexDelta5mMap.set(row.strike, d5);
    gexDelta10mMap.set(row.strike, d10);
    strikes.push(projectStrike(row, spot, d1, d5, d10));
  }

  const timestamps = resp?.availableMinutes ?? [];

  return {
    strikes,
    timestamps,
    gexDelta1mMap,
    gexDelta5mMap,
    gexDelta10mMap,
    loading,
    error,
    refresh,
  };
}
