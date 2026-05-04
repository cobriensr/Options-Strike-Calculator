/**
 * useGexLandscapeData — adapter that projects WS-fed `gex_strike_expiry`
 * rows into the `GexStrikeLevel` shape GexLandscape consumes, plus the
 * 5 per-window Δ% maps (1/5/10/15/30m) that the panel renders directly.
 *
 * GexLandscape was originally fed by `useGexPerStrike` →
 * `/api/gex-per-strike` → `gex_strike_0dte` (SPX-only, REST cron). Phase 3
 * of the GEX Landscape WebSocket-driven accuracy upgrade switched the
 * panel onto `useGexStrikeExpiry` → `/api/gex-strike-expiry` →
 * `ws_gex_strike_expiry` (multi-ticker, daemon-fed); Phase 4 then moved
 * Δ% computation off the client (which used to need a 30-minute snapshot
 * ring buffer) onto a server-side SQL `LAG()` query so the columns
 * populate immediately on first paint.
 *
 * This hook collapses the underlying multi-ticker `Record<Ticker, ...>`
 * to a single ticker's worth of strikes + timestamps + deltas because the
 * caller (the ticker-selector container in GexLandscape) has already
 * chosen one ticker. Returning the full Record would just push that
 * collapsing step into the consumer.
 *
 * Maps are built per-render via `useMemo` keyed on `sourceRows`, so
 * `strikes` and the delta maps advance atomically with the underlying
 * payload (a new poll = one render with all surfaces consistent).
 */

import { useMemo } from 'react';
import {
  useGexStrikeExpiry,
  type GexStrikeExpiryRow,
  type GexStrikeExpiryTicker,
} from './useGexStrikeExpiry';
import type { GexStrikeLevel } from '../components/GexLandscape/types';

export interface UseGexLandscapeDataReturn {
  strikes: GexStrikeLevel[];
  timestamps: string[];
  /**
   * Per-strike Δ% maps over the 1/5/10/15/30m windows, sourced from the
   * server-side `LAG()` columns on /api/gex-strike-expiry. Values are
   * percent (e.g. `5` for +5%) — matches the convention the legacy
   * client-side `computeDeltaMap` produced. `null` when no comparable
   * prior row exists in the lookback window.
   */
  gexDeltaMap: Map<number, number | null>;
  gexDelta5mMap: Map<number, number | null>;
  gexDelta10mMap: Map<number, number | null>;
  gexDelta15mMap: Map<number, number | null>;
  gexDelta30mMap: Map<number, number | null>;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/** Coalesce a possibly-null numeric field to 0 for the projected shape. */
function n(value: number | null): number {
  return value ?? 0;
}

/**
 * Pure projection: WS row → GexStrikeLevel. Extracted from the hook so
 * the field-naming bridge, net-field derivation, and volReinforcement
 * logic can be unit-tested without React.
 *
 * Fields with no WS-row equivalent (UW's `gex_strike_expiry` channel
 * doesn't publish per-strike delta — DEX, not the Δ% time-series) default
 * to 0. None of GexLandscape's current rendering paths read the DEX
 * delta fields; they live on the type for parity with the legacy
 * `useGexPerStrike` return.
 */
export function projectExpiryRowToStrike(
  row: GexStrikeExpiryRow,
): GexStrikeLevel {
  const callGammaOi = n(row.call_gamma_oi);
  const putGammaOi = n(row.put_gamma_oi);
  const callGammaVol = n(row.call_gamma_vol);
  const putGammaVol = n(row.put_gamma_vol);
  const callCharmOi = n(row.call_charm_oi);
  const putCharmOi = n(row.put_charm_oi);
  const callCharmVol = n(row.call_charm_vol);
  const putCharmVol = n(row.put_charm_vol);
  const callVannaOi = n(row.call_vanna_oi);
  const putVannaOi = n(row.put_vanna_oi);
  const callVannaVol = n(row.call_vanna_vol);
  const putVannaVol = n(row.put_vanna_vol);

  const netGammaOi = callGammaOi + putGammaOi;
  const netGammaVol = callGammaVol + putGammaVol;

  // Vol vs OI reinforcement: same sign = today's flow supports the level.
  // Inherited from the original `/api/gex-per-strike` row mapper that fed
  // GexLandscape pre-Phase 3 (since deleted with the REST endpoint).
  let volReinforcement: 'reinforcing' | 'opposing' | 'neutral' = 'neutral';
  if (netGammaOi !== 0 && netGammaVol !== 0) {
    const sameSign =
      (netGammaOi > 0 && netGammaVol > 0) ||
      (netGammaOi < 0 && netGammaVol < 0);
    volReinforcement = sameSign ? 'reinforcing' : 'opposing';
  }

  return {
    strike: row.strike,
    price: n(row.price),
    // Gamma — OI
    callGammaOi,
    putGammaOi,
    netGamma: netGammaOi,
    // Gamma — volume
    callGammaVol,
    putGammaVol,
    netGammaVol,
    volReinforcement,
    // Gamma — directionalized (bid/ask). UW's WS channel ships these as
    // `_ask_vol` / `_bid_vol`; GexLandscape's renderer reads them as
    // `callGammaAsk` etc.
    callGammaAsk: n(row.call_gamma_ask_vol),
    callGammaBid: n(row.call_gamma_bid_vol),
    putGammaAsk: n(row.put_gamma_ask_vol),
    putGammaBid: n(row.put_gamma_bid_vol),
    // Charm — OI
    callCharmOi,
    putCharmOi,
    netCharm: callCharmOi + putCharmOi,
    // Charm — volume
    callCharmVol,
    putCharmVol,
    netCharmVol: callCharmVol + putCharmVol,
    // Delta — UW's gex_strike_expiry channel doesn't publish delta;
    // default to 0. GexLandscape doesn't render these today (verified
    // 2026-05-03 via grep over src/components/GexLandscape/).
    callDeltaOi: 0,
    putDeltaOi: 0,
    netDelta: 0,
    // Vanna — OI
    callVannaOi,
    putVannaOi,
    netVanna: callVannaOi + putVannaOi,
    // Vanna — volume
    callVannaVol,
    putVannaVol,
    netVannaVol: callVannaVol + putVannaVol,
  };
}

/**
 * Build the 5 per-window Δ% maps from a row list. Extracted so the
 * keying logic stays close to the projection — both turn the same row
 * list into per-strike data and benefit from sharing a sourceRows dep.
 */
function buildDeltaMaps(rows: readonly GexStrikeExpiryRow[]): {
  gexDeltaMap: Map<number, number | null>;
  gexDelta5mMap: Map<number, number | null>;
  gexDelta10mMap: Map<number, number | null>;
  gexDelta15mMap: Map<number, number | null>;
  gexDelta30mMap: Map<number, number | null>;
} {
  const gexDeltaMap = new Map<number, number | null>();
  const gexDelta5mMap = new Map<number, number | null>();
  const gexDelta10mMap = new Map<number, number | null>();
  const gexDelta15mMap = new Map<number, number | null>();
  const gexDelta30mMap = new Map<number, number | null>();
  for (const r of rows) {
    gexDeltaMap.set(r.strike, r.gamma_delta_1m);
    gexDelta5mMap.set(r.strike, r.gamma_delta_5m);
    gexDelta10mMap.set(r.strike, r.gamma_delta_10m);
    gexDelta15mMap.set(r.strike, r.gamma_delta_15m);
    gexDelta30mMap.set(r.strike, r.gamma_delta_30m);
  }
  return {
    gexDeltaMap,
    gexDelta5mMap,
    gexDelta10mMap,
    gexDelta15mMap,
    gexDelta30mMap,
  };
}

export function useGexLandscapeData(
  ticker: GexStrikeExpiryTicker,
  marketOpen: boolean,
  expiry: string,
  at: string | null = null,
): UseGexLandscapeDataReturn {
  const { data, loading, error, refresh } = useGexStrikeExpiry(
    marketOpen,
    expiry,
    at,
  );

  const tickerData = data[ticker];

  // `rows` is recomputed every render via the `?? []` fallback, so we
  // memoize against the source `tickerData?.rows` reference (not the
  // fallback array, which would be a new identity each render). When
  // the ticker isn't fetched yet (`tickerData == null`), we fall back
  // to an empty array inside the memo so React's hook deps stay stable.
  const sourceRows = tickerData?.rows;
  const strikes = useMemo(
    () => (sourceRows ?? []).map(projectExpiryRowToStrike),
    [sourceRows],
  );

  // Δ% maps share the same source dep as `strikes` so the two derived
  // surfaces advance in lock-step (avoiding a render where strikes
  // updated but deltas still reference the previous payload).
  const deltaMaps = useMemo(
    () => buildDeltaMaps(sourceRows ?? []),
    [sourceRows],
  );

  const timestamps = tickerData?.timestamps ?? [];

  return {
    strikes,
    timestamps,
    gexDeltaMap: deltaMaps.gexDeltaMap,
    gexDelta5mMap: deltaMaps.gexDelta5mMap,
    gexDelta10mMap: deltaMaps.gexDelta10mMap,
    gexDelta15mMap: deltaMaps.gexDelta15mMap,
    gexDelta30mMap: deltaMaps.gexDelta30mMap,
    loading,
    error,
    refresh,
  };
}
