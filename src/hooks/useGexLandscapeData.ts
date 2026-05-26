/**
 * useGexLandscapeData — fetches the per-strike GEX landscape from the
 * 1-min GexBot-fed `/api/gex-landscape` endpoint and projects each row
 * into the `GexStrikeLevel` shape the GexLandscape renderer consumes.
 *
 * Phase 2 of the GEX Landscape 1-min GexBot rebuild
 * (docs/superpowers/specs/gex-landscape-1min-gexbot-rebuild-2026-05-26.md).
 * Replaces the dual-source MM (`usePeriscopeStrikes`) + WS
 * (`useGexStrikeExpirySpx`) path with a single endpoint that already
 * carries the `[t-1m, t-5m, t-10m]` prior values per strike — no
 * client-side lookback fetches needed.
 *
 * Δ% maps (1m / 5m / 10m) are computed inline against each row's
 * `prevNm` field using the same `DELTA_NOISE_FLOOR` semantics the
 * legacy hook used (|prior| < 100 → null). The 15m / 30m maps and all
 * `naiveDelta*` maps are returned as empty `Map`s for backwards
 * compatibility with the Phase 2-pinned components (StrikeTable,
 * BiasPanel, bias.ts); Phases 3 and 4 drop those fields properly.
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
  gexDeltaMap: Map<number, number | null>;
  gexDelta5mMap: Map<number, number | null>;
  gexDelta10mMap: Map<number, number | null>;
  /**
   * Phase 2 compat: returned as empty Maps. The 15m / 30m windows go
   * away in Phase 3 (types + BiasPanel rebuild); until then bias.ts
   * still reads `gexDelta30mMap` for `floorTrend30m` and the panel
   * renders `—` for that row, which is the expected intermediate
   * state per the spec.
   */
  gexDelta15mMap: Map<number, number | null>;
  gexDelta30mMap: Map<number, number | null>;
  /**
   * Phase 2 compat: returned as empty Maps. The WS side-channel that
   * fed these is gone; Phase 3 redefines `volReinforcement` as
   * delta-trend agreement and drops the naive sub-line entirely.
   */
  naiveDelta1mMap: Map<number, number | null>;
  naiveDelta5mMap: Map<number, number | null>;
  naiveDelta10mMap: Map<number, number | null>;
  naiveDelta30mMap: Map<number, number | null>;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Magnitude floor for the Δ% denominator. Strikes whose prior gamma
 * magnitude is below this floor produce huge meaningless percentages
 * (a +5 strike against a 0.01 prior reads 50,000% Δ); the floor maps
 * those to `null` so the BiasPanel mean and the StrikeTable cells
 * don't get poisoned. Same value the MM-era hook used — calibrated
 * against ATM gamma p10 ~112 at MM scale. The spec notes GexBot
 * scale may differ; revisit in Phase 4's threshold tune.
 */
const DELTA_NOISE_FLOOR = 100;

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
 * - `volReinforcement` is `'neutral'` for the entire Phase 2 window.
 *   Phase 3 redefines it as delta-trend agreement (sign(Δ1m) ===
 *   sign(Δ5m) === sign(Δ10m) === sign(netGamma) → 'reinforcing'); for
 *   now a placeholder keeps the StrikeTable column rendering without
 *   crashing.
 */
export function projectStrike(
  row: GexLandscapeStrikeRow,
  spot: number,
): GexStrikeLevel {
  return {
    strike: row.strike,
    price: spot,
    callGammaOi: 0,
    putGammaOi: 0,
    netGamma: row.gamma,
    callGammaVol: 0,
    putGammaVol: 0,
    netGammaVol: 0,
    volReinforcement: 'neutral',
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

/**
 * ISO timestamp → CT HH:MM (24h) — preserved here in case the endpoint
 * adopts a `?time` shape later. Currently /api/gex-landscape takes a
 * raw `?at=ISO` so we pass through the input directly.
 */
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
  const sourceRows = resp?.data?.strikes ?? [];
  const spot = resp?.data?.spot ?? 0;
  const strikes: GexStrikeLevel[] = sourceRows.map((row) =>
    projectStrike(row, spot),
  );

  const gexDeltaMap = new Map<number, number | null>();
  const gexDelta5mMap = new Map<number, number | null>();
  const gexDelta10mMap = new Map<number, number | null>();
  for (const row of sourceRows) {
    gexDeltaMap.set(row.strike, computeDelta(row.gamma, row.gammaPrev1m));
    gexDelta5mMap.set(row.strike, computeDelta(row.gamma, row.gammaPrev5m));
    gexDelta10mMap.set(row.strike, computeDelta(row.gamma, row.gammaPrev10m));
  }

  // Phase 2 compat: empty Maps for fields owned by Phase 3 cleanup.
  // Allocating fresh each render is cheap (empty Map) and matches the
  // referential pattern of the populated maps above.
  const emptyMap: Map<number, number | null> = new Map();

  const timestamps = resp?.availableMinutes ?? [];

  return {
    strikes,
    timestamps,
    gexDeltaMap,
    gexDelta5mMap,
    gexDelta10mMap,
    gexDelta15mMap: emptyMap,
    gexDelta30mMap: emptyMap,
    naiveDelta1mMap: emptyMap,
    naiveDelta5mMap: emptyMap,
    naiveDelta10mMap: emptyMap,
    naiveDelta30mMap: emptyMap,
    loading,
    error,
    refresh,
  };
}
