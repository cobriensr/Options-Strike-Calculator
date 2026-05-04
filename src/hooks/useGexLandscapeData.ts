/**
 * useGexLandscapeData — adapter that projects WS-fed `gex_strike_expiry`
 * rows into the `GexStrikeLevel` shape GexLandscape consumes.
 *
 * GexLandscape was originally fed by `useGexPerStrike` →
 * `/api/gex-per-strike` → `gex_strike_0dte` (SPX-only, REST cron). Phase 3
 * of the GEX Landscape WebSocket-driven accuracy upgrade switches the
 * panel onto `useGexStrikeExpiry` → `/api/gex-strike-expiry` →
 * `ws_gex_strike_expiry` (multi-ticker, daemon-fed). The two row shapes
 * differ in field naming (`call_gamma_ask_vol` vs `callGammaAsk`), and
 * the WS row doesn't ship delta — so we bridge via this adapter rather
 * than rewriting GexLandscape's renderer.
 *
 * This hook collapses the underlying multi-ticker `Record<Ticker, ...>`
 * to a single ticker's worth of strikes + timestamps because the caller
 * (a future ticker-selector container in Phase 3c) has already chosen
 * one ticker. Returning the full Record would just push that collapsing
 * step into the consumer.
 *
 * `useGexStrikeExpiry`'s runtime fetch list currently iterates only
 * SPY/QQQ (Phase 3a decision). For SPX/NDX, `data[ticker]` is `null`
 * and this adapter returns empty `strikes` / `timestamps`. That's fine
 * — Phase 3c's UI will only enable selecting tickers that actually
 * have data flowing.
 */

import { useMemo } from 'react';
import {
  useGexStrikeExpiry,
  type GexStrikeExpiryRow,
  type GexStrikeExpiryTicker,
} from './useGexStrikeExpiry';
import type { GexStrikeLevel } from './useGexPerStrike';

export interface UseGexLandscapeDataReturn {
  strikes: GexStrikeLevel[];
  timestamps: string[];
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
 * doesn't publish per-strike delta) default to 0. None of GexLandscape's
 * current rendering paths read the delta fields — they live on the type
 * for parity with the legacy `useGexPerStrike` return.
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
  // Mirrors the canonical derivation in api/gex-per-strike.ts:78-84.
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

  const timestamps = tickerData?.timestamps ?? [];

  return { strikes, timestamps, loading, error, refresh };
}
