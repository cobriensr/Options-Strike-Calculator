/**
 * Query helpers for the /api/greek-heatmap endpoint.
 *
 * Two reads, both targeting websocket-fed tables that uw-stream writes
 * for the lottery alerts universe:
 *
 * - `ws_gex_strike_expiry` — per-minute snapshot of call/put gamma,
 *   charm, vanna (and the underlying spot) for every strike on a
 *   ticker's expiry chain. We collapse to the latest minute per strike
 *   via `DISTINCT ON (strike) ... ORDER BY ts_minute DESC`. The
 *   (ticker, expiry, ts_minute DESC) index from migration #111 covers
 *   the scan.
 *
 * - `ws_net_flow_per_ticker` — per-tick DELTAS of net call/put premium
 *   and volume (NOT running totals; see uw-stream/src/handlers/net_flow
 *   for the rationale). Session-cumulative is computed at read time
 *   via `SUM(...) OVER (PARTITION BY ticker, date(ts) ORDER BY ts)` so
 *   the daemon can stay single-sourced.
 *
 * See docs/superpowers/specs/per-ticker-greek-heatmap-2026-05-15.md.
 */

import { getDb } from './db.js';

export type GreekHeatmapTopStrike = {
  strike: number;
  callGammaOi: number | null;
  putGammaOi: number | null;
  netGamma: number;
  callCharmOi: number | null;
  putCharmOi: number | null;
  netCharm: number;
  callVannaOi: number | null;
  putVannaOi: number | null;
  netVanna: number;
};

export type GreekHeatmapSnapshot = {
  expiry: string | null;
  asOf: string | null;
  underlyingPrice: number | null;
  atmStrike: number | null;
  regime: 'Long Γ' | 'Short Γ' | null;
  netGexK: number | null;
  topStrikes: GreekHeatmapTopStrike[];
};

export type GreekHeatmapNetFlow = {
  cumulativeCallPrem: number;
  cumulativeCallVol: number;
  cumulativePutPrem: number;
  cumulativePutVol: number;
  asOf: string;
};

type GexRow = {
  strike: string | number;
  ts_minute: Date;
  price: string | null;
  call_gamma_oi: string | null;
  put_gamma_oi: string | null;
  call_charm_oi: string | null;
  put_charm_oi: string | null;
  call_vanna_oi: string | null;
  put_vanna_oi: string | null;
};

type NetFlowRow = {
  ts: Date;
  cum_call_prem: string;
  cum_call_vol: string;
  cum_put_prem: string;
  cum_put_vol: string;
};

const TOP_STRIKE_LIMIT = 5;

export async function getGreekHeatmapSnapshot(
  ticker: string,
  expiry: string,
): Promise<GreekHeatmapSnapshot> {
  const db = getDb();

  const rows = (await db`
    SELECT DISTINCT ON (strike)
      strike,
      ts_minute,
      price,
      call_gamma_oi,
      put_gamma_oi,
      call_charm_oi,
      put_charm_oi,
      call_vanna_oi,
      put_vanna_oi
    FROM ws_gex_strike_expiry
    WHERE ticker = ${ticker}
      AND expiry = ${expiry}::date
    ORDER BY strike, ts_minute DESC
  `) as GexRow[];

  if (rows.length === 0) {
    return {
      expiry: null,
      asOf: null,
      underlyingPrice: null,
      atmStrike: null,
      regime: null,
      netGexK: null,
      topStrikes: [],
    };
  }

  const allStrikes = rows.map<GreekHeatmapTopStrike>((r) => {
    const cg = num(r.call_gamma_oi);
    const pg = num(r.put_gamma_oi);
    const cc = num(r.call_charm_oi);
    const pc = num(r.put_charm_oi);
    const cv = num(r.call_vanna_oi);
    const pv = num(r.put_vanna_oi);
    return {
      strike: Number(r.strike),
      callGammaOi: cg,
      putGammaOi: pg,
      netGamma: (cg ?? 0) + (pg ?? 0),
      callCharmOi: cc,
      putCharmOi: pc,
      netCharm: (cc ?? 0) + (pc ?? 0),
      callVannaOi: cv,
      putVannaOi: pv,
      netVanna: (cv ?? 0) + (pv ?? 0),
    };
  });

  const topStrikes = [...allStrikes]
    .sort((a, b) => Math.abs(b.netGamma) - Math.abs(a.netGamma))
    .slice(0, TOP_STRIKE_LIMIT);

  // Regime + aggregate use the full chain, not just top-5 — the trader
  // wants to know the dealer's net Γ posture across every strike.
  const totalNetGamma = allStrikes.reduce((acc, s) => acc + s.netGamma, 0);
  const netGexK = totalNetGamma / 1000;
  const regime: 'Long Γ' | 'Short Γ' = totalNetGamma > 0 ? 'Long Γ' : 'Short Γ';

  // UW emits one batch per ticker per minute; every row in a batch
  // shares the same ts_minute and price. Use MAX defensively in case
  // a flush straddled two minutes.
  let latestMinute = rows[0]!.ts_minute;
  for (const r of rows) {
    if (r.ts_minute > latestMinute) latestMinute = r.ts_minute;
  }
  const latestRow =
    rows.find((r) => r.ts_minute.getTime() === latestMinute.getTime()) ??
    rows[0]!;
  const underlyingPrice = num(latestRow.price);

  // ATM = closest of the returned top-5 to spot. The literal ATM
  // strike isn't guaranteed to be in top-5 when GEX is concentrated
  // away from spot; this gives the trader the dealer-wall-nearest-to-
  // spot read, which is what's actionable for exit timing.
  let atmStrike: number | null = null;
  if (underlyingPrice !== null && topStrikes.length > 0) {
    let closest = topStrikes[0]!.strike;
    for (const s of topStrikes) {
      if (
        Math.abs(s.strike - underlyingPrice) <
        Math.abs(closest - underlyingPrice)
      ) {
        closest = s.strike;
      }
    }
    atmStrike = closest;
  }

  return {
    expiry,
    asOf: latestMinute.toISOString(),
    underlyingPrice,
    atmStrike,
    regime,
    netGexK,
    topStrikes,
  };
}

export async function getGreekHeatmapNetFlow(
  ticker: string,
  date: string,
): Promise<GreekHeatmapNetFlow | null> {
  const db = getDb();

  const rows = (await db`
    SELECT
      ts,
      SUM(net_call_prem) OVER w AS cum_call_prem,
      SUM(net_call_vol)  OVER w AS cum_call_vol,
      SUM(net_put_prem)  OVER w AS cum_put_prem,
      SUM(net_put_vol)   OVER w AS cum_put_vol
    FROM ws_net_flow_per_ticker
    WHERE ticker = ${ticker}
      AND date(ts) = ${date}::date
    WINDOW w AS (PARTITION BY ticker, date(ts) ORDER BY ts)
    ORDER BY ts DESC
    LIMIT 1
  `) as NetFlowRow[];

  if (rows.length === 0) return null;

  const r = rows[0]!;
  return {
    cumulativeCallPrem: Number.parseFloat(r.cum_call_prem),
    cumulativeCallVol: Number.parseInt(r.cum_call_vol, 10),
    cumulativePutPrem: Number.parseFloat(r.cum_put_prem),
    cumulativePutVol: Number.parseInt(r.cum_put_vol, 10),
    asOf: r.ts.toISOString(),
  };
}

function num(s: string | number | null | undefined): number | null {
  if (s == null) return null;
  const n = typeof s === 'number' ? s : Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
