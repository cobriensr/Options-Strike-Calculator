/**
 * useGexLandscapeData — adapts MM-attributed strike data from
 * `usePeriscopeStrikes` into the `GexStrikeLevel` shape GexLandscape
 * consumes, with the call/put-split **vol reinforcement** column
 * sourced from the WS-fed `useGexStrikeExpiry` SPX feed (the only
 * place ask/bid attribution exists).
 *
 * Phase 2 of the GEX Landscape MM swap
 * (docs/superpowers/specs/gex-landscape-mm-swap-2026-05-12.md).
 * Replaces the WS-as-primary architecture; WS data now serves a
 * side-channel role (vol reinforcement + ask/bid only).
 *
 * Δ% maps at 10-min cadence compress to: gexDelta10mMap (1-slot diff),
 * gexDelta20mMap (2-slot), gexDelta30mMap (3-slot). The 1m / 5m / 15m
 * fields stay on the return type as empty maps for Phase 2 backwards
 * compat with the renderer — Phase 3 drops the dead columns + fields.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePeriscopeStrikes } from './usePeriscopeStrikes';
import {
  useGexStrikeExpirySpx,
  type GexStrikeExpiryRow,
} from './useGexStrikeExpiry';
import type { GexStrikeLevel } from '../components/GexLandscape/types';

export interface UseGexLandscapeDataReturn {
  strikes: GexStrikeLevel[];
  timestamps: string[];
  /**
   * Per-strike Δ% (percent; e.g. 5 for +5%). `null` means no comparable
   * prior slot exists in the lookback window.
   *
   * At 10-min MM cadence the windows compress: `10m` = 1-slot diff,
   * `30m` = 3-slot. The `1m` / `5m` / `15m` maps are always empty
   * here — kept on the return type for Phase 2 backwards compatibility
   * with the GexLandscape renderer; Phase 3 drops the dead columns
   * and these map fields, and ADDS `gexDelta20mMap` once StrikeTable
   * wires the 20m column. Adding 20m here without a consumer would
   * be a wasted lookback fetch.
   */
  gexDeltaMap: Map<number, number | null>;
  gexDelta5mMap: Map<number, number | null>;
  gexDelta10mMap: Map<number, number | null>;
  gexDelta15mMap: Map<number, number | null>;
  gexDelta30mMap: Map<number, number | null>;
  /**
   * Naive per-strike Δ% sourced from the WS feed's server-computed
   * `gamma_delta_*m` fields (SQL `LAG()` over
   * `ws_gex_strike_expiry.ts_minute`). 1m / 5m / 10m are the fast-cadence
   * windows that MM data cannot expose (periscope cadence is 10 min);
   * 30m is the session-scale window used by the BiasPanel.
   *
   * No client-side noise floor here — server uses `NULLIF(ABS(...),0)`
   * which only filters exact-zero priors. Tiny OTM strikes may surface
   * large percentages; aggregations in `bias.ts` use means, so a few
   * outliers don't dominate the floor/ceiling trend numbers.
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
 * has |value| < this floor produce huge meaningless percentages
 * (a +5 strike against a 0.01 prior reads 50,000% Δ); the floor maps
 * those to `null` so the BiasPanel mean and the StrikeTable cells
 * don't get poisoned. The value was chosen from the Phase 4 probe
 * (scripts/probe-mm-bias-calibration.mjs): ATM strike |gamma| p10
 * across 5 days = 112, so 100 sits just below typical ATM and only
 * filters near-zero strikes (which have no economic meaning at MM
 * scale anyway).
 */
const DELTA_NOISE_FLOOR = 100;

/**
 * Build a single Δ% map from the current MM strikes vs. a prior slot's
 * gamma-keyed lookup. Percent change uses `|prior|` as the denominator
 * so the sign of the delta reflects movement direction even when the
 * prior gamma is negative (the natural case in negative-gamma regimes).
 * Returns `null` when the strike isn't in the lookback OR the prior
 * gamma's magnitude is below `DELTA_NOISE_FLOOR`.
 */
function buildDeltaMap(
  currentStrikes: ReadonlyArray<{ strike: number; gamma: number }>,
  prior: Map<number, number> | null,
): Map<number, number | null> {
  const out = new Map<number, number | null>();
  if (prior == null) {
    for (const r of currentStrikes) out.set(r.strike, null);
    return out;
  }
  for (const r of currentStrikes) {
    const p = prior.get(r.strike);
    if (p === undefined || Math.abs(p) < DELTA_NOISE_FLOOR) {
      out.set(r.strike, null);
    } else {
      out.set(r.strike, ((r.gamma - p) / Math.abs(p)) * 100);
    }
  }
  return out;
}

/**
 * Project an MM strike row (+ optional matching WS row) into the
 * `GexStrikeLevel` shape the GexLandscape renderer consumes.
 *
 * - MM gamma → `netGamma`; MM charm → `netCharm`. MM data does NOT
 *   split call/put attribution (UW's dealer math collapses the two
 *   sides), so the call/put _MM_ OI fields stay zero.
 * - The WS side channel supplies:
 *   - `callGammaOi` / `putGammaOi` — raw OI gamma, the NAIVE GEX
 *     numerator. Surfaced so downstream consumers can compute
 *     `callGammaOi + putGammaOi` for the naive sub-read alongside MM.
 *   - `callGammaAsk` / `callGammaBid` / `putGammaAsk` / `putGammaBid`
 *     — bid/ask attribution for the gamma-pressure cue.
 *   - `volReinforcement` verdict from OI vs vol sign agreement.
 *   Missing WS data (e.g. ticker mismatch) zeroes the naive fields
 *   and drops `volReinforcement` to `neutral` — the MM read still
 *   renders cleanly without the WS sub-channel.
 * - Vanna and delta fields are zeroed (out of Phase 2 scope).
 */
export function projectMmStrike(
  mmRow: { strike: number; gamma: number; charm: number },
  spot: number,
  wsRow: GexStrikeExpiryRow | undefined,
): GexStrikeLevel {
  const callGammaOi = wsRow?.call_gamma_oi ?? 0;
  const putGammaOi = wsRow?.put_gamma_oi ?? 0;
  const callGammaAsk = wsRow?.call_gamma_ask_vol ?? 0;
  const callGammaBid = wsRow?.call_gamma_bid_vol ?? 0;
  const putGammaAsk = wsRow?.put_gamma_ask_vol ?? 0;
  const putGammaBid = wsRow?.put_gamma_bid_vol ?? 0;

  let volReinforcement: 'reinforcing' | 'opposing' | 'neutral' = 'neutral';
  if (wsRow) {
    const netGammaOi = callGammaOi + putGammaOi;
    const netGammaVol =
      (wsRow.call_gamma_vol ?? 0) + (wsRow.put_gamma_vol ?? 0);
    if (netGammaOi !== 0 && netGammaVol !== 0) {
      const sameSign =
        (netGammaOi > 0 && netGammaVol > 0) ||
        (netGammaOi < 0 && netGammaVol < 0);
      volReinforcement = sameSign ? 'reinforcing' : 'opposing';
    }
  }

  return {
    strike: mmRow.strike,
    price: spot,
    callGammaOi,
    putGammaOi,
    netGamma: mmRow.gamma,
    callGammaVol: 0,
    putGammaVol: 0,
    netGammaVol: 0,
    volReinforcement,
    callGammaAsk,
    callGammaBid,
    putGammaAsk,
    putGammaBid,
    callCharmOi: 0,
    putCharmOi: 0,
    netCharm: mmRow.charm,
    callCharmVol: 0,
    putCharmVol: 0,
    netCharmVol: 0,
    callDeltaOi: 0,
    putDeltaOi: 0,
    netDelta: 0,
    callVannaOi: 0,
    putVannaOi: 0,
    netVanna: 0,
    callVannaVol: 0,
    putVannaVol: 0,
    netVannaVol: 0,
  };
}

export function useGexLandscapeData(
  marketOpen: boolean,
  expiry: string,
  at: string | null = null,
): UseGexLandscapeDataReturn {
  const primary = usePeriscopeStrikes(marketOpen, expiry, at);
  const ws = useGexStrikeExpirySpx(marketOpen, expiry, at);

  // O(N) lookup of WS rows by strike so the projection doesn't run a
  // linear scan per strike. Memoized on the source `rows` reference so
  // the map identity is stable across renders with the same payload.
  const wsByStrike = useMemo<Map<number, GexStrikeExpiryRow>>(() => {
    const m = new Map<number, GexStrikeExpiryRow>();
    for (const r of ws.data?.rows ?? []) m.set(r.strike, r);
    return m;
  }, [ws.data?.rows]);

  const spot = primary.latest?.spot ?? 0;
  const sourceStrikes = primary.latest?.strikes;

  const strikes = useMemo<GexStrikeLevel[]>(
    () =>
      (sourceStrikes ?? []).map((mm) =>
        projectMmStrike(mm, spot, wsByStrike.get(mm.strike)),
      ),
    [sourceStrikes, spot, wsByStrike],
  );

  const gexDelta10mMap = useMemo(
    () => buildDeltaMap(sourceStrikes ?? [], primary.prior10m),
    [sourceStrikes, primary.prior10m],
  );
  const gexDelta30mMap = useMemo(
    () => buildDeltaMap(sourceStrikes ?? [], primary.prior30m),
    [sourceStrikes, primary.prior30m],
  );

  // Naive Δ% maps — pulled directly from each WS row's server-computed
  // `gamma_delta_*m` fields (SQL `LAG()` already ran on the server,
  // no client-side recompute needed). Strikes present in MM but
  // absent from WS get `null` — the table cell and the bias panel
  // both treat null as "no data" and render `—`.
  const naiveDelta1mMap = useMemo<Map<number, number | null>>(() => {
    const m = new Map<number, number | null>();
    for (const mm of sourceStrikes ?? []) {
      const wsRow = wsByStrike.get(mm.strike);
      m.set(mm.strike, wsRow?.gamma_delta_1m ?? null);
    }
    return m;
  }, [sourceStrikes, wsByStrike]);
  const naiveDelta5mMap = useMemo<Map<number, number | null>>(() => {
    const m = new Map<number, number | null>();
    for (const mm of sourceStrikes ?? []) {
      const wsRow = wsByStrike.get(mm.strike);
      m.set(mm.strike, wsRow?.gamma_delta_5m ?? null);
    }
    return m;
  }, [sourceStrikes, wsByStrike]);
  const naiveDelta10mMap = useMemo<Map<number, number | null>>(() => {
    const m = new Map<number, number | null>();
    for (const mm of sourceStrikes ?? []) {
      const wsRow = wsByStrike.get(mm.strike);
      m.set(mm.strike, wsRow?.gamma_delta_10m ?? null);
    }
    return m;
  }, [sourceStrikes, wsByStrike]);
  const naiveDelta30mMap = useMemo<Map<number, number | null>>(() => {
    const m = new Map<number, number | null>();
    for (const mm of sourceStrikes ?? []) {
      const wsRow = wsByStrike.get(mm.strike);
      m.set(mm.strike, wsRow?.gamma_delta_30m ?? null);
    }
    return m;
  }, [sourceStrikes, wsByStrike]);

  // Empty-map back-compat for fields the Phase 2 component still
  // references (1m / 5m / 15m columns). Phase 3 removes them.
  const emptyMap = useMemo<Map<number, number | null>>(() => new Map(), []);

  // Picker timestamps — prefer the WS feed's 1-min resolution list
  // over MM's 10-min `availableSlots` so the trader can scrub at
  // minute granularity (the cadence at which the Phase 5 naive Δ%
  // columns carry signal). MM columns at-or-before resolve on the
  // server when the user lands on a non-10-min minute, so the MM Γ /
  // MM 10m / MM 30m cells stick for up to 10 minutes — that's
  // already the data's natural behavior, just exposed at finer
  // granularity in the picker.
  //
  // We CACHE the last known live (non-scrubbed) WS timestamps in
  // state rather than reading `ws.data.timestamps` directly. The WS
  // endpoint truncates `timestamps` to `<= at` while scrubbed, so
  // returning the live response's list directly would cause a
  // single-render flash when the user clicks Live: the in-flight
  // `ws.data` still holds the scrubbed (truncated) response until
  // the next poll lands, which would shrink the picker for one
  // render. Caching the last live list keeps the picker stable
  // across the scrub → Live transition.
  //
  // Fallback to MM slots when no live WS response has ever arrived
  // (first paint, side-channel error, 401 for public visitors) so
  // the picker isn't empty.
  const [livePickerTimestamps, setLivePickerTimestamps] = useState<string[]>(
    [],
  );
  // Reset the cache when the expiry changes. `useGexStrikeExpirySpx`
  // is sticky-on-empty, so without this reset the picker would
  // briefly show yesterday's minute list against today's chain until
  // the new live WS response lands.
  useEffect(() => {
    setLivePickerTimestamps([]);
  }, [expiry]);
  const wsAt = ws.data?.at ?? null;
  const wsRawTimestamps = ws.data?.timestamps;
  useEffect(() => {
    // `at === null` on the response means the WS endpoint returned a
    // live (non-truncated) timestamps list. Only those are eligible
    // for the picker cache.
    if (wsAt !== null) return;
    if (!wsRawTimestamps || wsRawTimestamps.length === 0) return;
    // Skip the state update when contents are unchanged — every poll
    // allocates a fresh array reference even when the underlying
    // minute list is identical, so a naive setState would re-render
    // (and re-fire `index.tsx`'s `liveTimestamps` mirror effect) on
    // every poll.
    setLivePickerTimestamps((prev) => {
      if (
        prev.length === wsRawTimestamps.length &&
        prev.every((t, i) => t === wsRawTimestamps[i])
      ) {
        return prev;
      }
      return wsRawTimestamps;
    });
  }, [wsAt, wsRawTimestamps]);
  const timestamps =
    livePickerTimestamps.length > 0
      ? livePickerTimestamps
      : (primary.latest?.availableSlots ?? []);

  // Primary errors take precedence (MM is the structural read).
  // WS side-channel errors degrade vol reinforcement only — surface
  // them as a softer prefixed message so the user knows what's
  // missing, but don't suppress the MM-driven render.
  const error =
    primary.error ?? (ws.error ? `SPX vol reinforcement: ${ws.error}` : null);

  const refresh = useCallback(() => {
    primary.refresh();
    ws.refresh();
  }, [primary, ws]);

  return {
    strikes,
    timestamps,
    gexDeltaMap: emptyMap,
    gexDelta5mMap: emptyMap,
    gexDelta10mMap,
    gexDelta15mMap: emptyMap,
    gexDelta30mMap,
    naiveDelta1mMap,
    naiveDelta5mMap,
    naiveDelta10mMap,
    naiveDelta30mMap,
    loading: primary.loading,
    error,
    refresh,
  };
}
