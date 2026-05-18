/**
 * Query helpers for the /api/greek-heatmap endpoint.
 *
 * Three reads:
 *
 * - Chain snapshot (`getGreekHeatmapSnapshot`) — pulls ws_gex_strike_
 *   expiry rows for the chosen (ticker, expiry) and returns:
 *     • `chainStrikes` — the ATM ± 50 strikes (sorted by strike asc)
 *       for the full heatmap grid.
 *     • `topStrikes` — the top 5 by |net gamma OI| (sorted by |net|
 *       desc) for the callout chips.
 *     • Regime, netGexK, underlyingPrice, atmStrike — derived from
 *       the FULL chain, not just the windowed slice.
 *
 *   Uses `DISTINCT ON (strike) ... ORDER BY ts_minute DESC` to collapse
 *   to the latest minute per strike. Covered by the
 *   (ticker, strike, ts_minute DESC) index from migration #111.
 *
 * - Net flow (`getGreekHeatmapNetFlow`) — session-cumulative NCP/NPP/
 *   vol for the chosen ticker on the chosen date. For today, reads
 *   from ws_net_flow_per_ticker (live WS deltas). For historical
 *   dates, reads from net_flow_per_ticker_history (REST backfill,
 *   source='rest'). Same SUM(...) OVER pattern either way.
 *
 * See docs/superpowers/specs/per-ticker-greek-heatmap-2026-05-15.md.
 */

import { getDb, withDbRetry } from './db.js';

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
  chainStrikes: GreekHeatmapTopStrike[];
  topStrikes: GreekHeatmapTopStrike[];
  /**
   * Intraday timestamp coverage for this (ticker, expiry). Drives the
   * scrubber bounds on the client: `min` and `max` give the first /
   * last ts_minute we have on the chosen date; `count` distinguishes
   * "intraday-rich" (>1) from "EOD only" (1) so the UI can disable
   * the scrubber and badge the gap when no minute resolution exists.
   * `null` when there's no data for the (ticker, expiry) pair.
   */
  intradayRange: {
    min: string;
    max: string;
    count: number;
  } | null;
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
const CHAIN_STRIKE_WINDOW = 50; // ± strikes around ATM (100 total).

export async function getGreekHeatmapSnapshot(
  ticker: string,
  expiry: string,
  today: string,
  at: string | undefined = undefined,
): Promise<GreekHeatmapSnapshot> {
  const db = getDb();
  const isToday = expiry === today;
  // `at` upper-bounds the per-strike snapshot when scrubbing. When
  // null, we pull the latest row per strike (live tip).
  const atCutoff = at ?? null;

  // For today, read the live WS feed (ws_gex_strike_expiry). For
  // historical dates, read the REST-backfilled archive
  // (strike_exposures). Both share the per-strike OI Greek shape so
  // we normalize to the same intermediate row type and the downstream
  // top-N / chain-windowing / regime math stays unchanged.
  //
  // NOTE: `ws_gex_strike_expiry` holds SPXW rows for the 0DTE chain
  // (not SPX). The Greek Heatmap is gated by the lottery universe
  // (api/_lib/validation/greek-heatmap.ts) which allows SPXW only,
  // so this code path can't currently be hit with ticker='SPX'. If
  // SPX is ever added to the universe, also apply the SPX→SPXW
  // alias from `db-gex-strike-expiry.ts::resolveStoredTicker` here,
  // or queries will silently return zero rows.
  // withDbRetry covers transient Neon HTTP failures (fetch failed,
  // ECONNRESET, socket hang up). The frontend polls this endpoint
  // every 30s; one unretried blip cascades into Sentry as
  // SENTRY-EMERALD-DESERT-8X. 10s per-attempt timeout shields against
  // hung connections without exceeding the function's 300s budget.
  const rows = (await withDbRetry(
    () =>
      isToday
        ? db`
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
          AND (${atCutoff}::timestamptz IS NULL
               OR ts_minute <= ${atCutoff}::timestamptz)
        ORDER BY strike, ts_minute DESC
      `
        : db`
          SELECT DISTINCT ON (strike)
            strike,
            timestamp AS ts_minute,
            price,
            call_gamma_oi,
            put_gamma_oi,
            call_charm_oi,
            put_charm_oi,
            call_vanna_oi,
            put_vanna_oi
          FROM strike_exposures
          WHERE ticker = ${ticker}
            AND expiry = ${expiry}::date
            AND (${atCutoff}::timestamptz IS NULL
                 OR timestamp <= ${atCutoff}::timestamptz)
          ORDER BY strike, timestamp DESC
        `,
    2,
    10000,
  )) as GexRow[];

  // Intraday coverage probe — separate query so it's not gated by
  // `at` (the scrubber needs to know the full available range, not
  // just up to where it currently is). One row per distinct ts_minute,
  // collapsed to min/max/count.
  const rangeRows = (await withDbRetry(
    () =>
      isToday
        ? db`
        SELECT
          MIN(ts_minute)::text AS first,
          MAX(ts_minute)::text AS last,
          COUNT(DISTINCT ts_minute)::int AS distinct_count
        FROM ws_gex_strike_expiry
        WHERE ticker = ${ticker}
          AND expiry = ${expiry}::date
      `
        : db`
          SELECT
            MIN(timestamp)::text AS first,
            MAX(timestamp)::text AS last,
            COUNT(DISTINCT timestamp)::int AS distinct_count
          FROM strike_exposures
          WHERE ticker = ${ticker}
            AND expiry = ${expiry}::date
        `,
    2,
    10000,
  )) as {
    first: string | null;
    last: string | null;
    distinct_count: number;
  }[];
  const intradayRange = buildIntradayRange(rangeRows[0]);

  if (rows.length === 0) {
    return {
      expiry: null,
      asOf: null,
      underlyingPrice: null,
      atmStrike: null,
      regime: null,
      netGexK: null,
      chainStrikes: [],
      topStrikes: [],
      intradayRange,
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
  // shares the same ts_minute and price. Use MAX defensively.
  let latestMinute = rows[0]!.ts_minute;
  for (const r of rows) {
    if (r.ts_minute > latestMinute) latestMinute = r.ts_minute;
  }
  const latestRow =
    rows.find((r) => r.ts_minute.getTime() === latestMinute.getTime()) ??
    rows[0]!;
  const underlyingPrice = num(latestRow.price);

  // Build the ATM ± 50 strike window (100 strikes total). Sort by
  // proximity to spot, take 100, then re-sort by strike DESC for the
  // grid display (highest strike at the top, matching the Periscope
  // visual). If spot is null (rare — first-tick edge case), fall back
  // to the middle 100 by strike index.
  let chainStrikes: GreekHeatmapTopStrike[];
  if (underlyingPrice !== null) {
    chainStrikes = [...allStrikes]
      .sort(
        (a, b) =>
          Math.abs(a.strike - underlyingPrice) -
          Math.abs(b.strike - underlyingPrice),
      )
      .slice(0, CHAIN_STRIKE_WINDOW * 2)
      .sort((a, b) => b.strike - a.strike);
  } else {
    const byStrike = [...allStrikes].sort((a, b) => b.strike - a.strike);
    const mid = Math.floor(byStrike.length / 2);
    chainStrikes = byStrike.slice(
      Math.max(0, mid - CHAIN_STRIKE_WINDOW),
      mid + CHAIN_STRIKE_WINDOW,
    );
  }

  // ATM strike = closest of the rendered chain to spot.
  let atmStrike: number | null = null;
  if (underlyingPrice !== null && chainStrikes.length > 0) {
    let closest = chainStrikes[0]!.strike;
    for (const s of chainStrikes) {
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
    chainStrikes,
    topStrikes,
    intradayRange,
  };
}

/**
 * Session-cumulative net flow for `ticker` on the given `date`.
 *
 * For today, reads from ws_net_flow_per_ticker (the live WS feed).
 * For historical dates, reads from net_flow_per_ticker_history with
 * source='rest' (the REST-backfilled archive). Same SUM(...) OVER
 * pattern either way; the source switch handles the
 * data-retention boundary at end-of-day.
 */
export async function getGreekHeatmapNetFlow(
  ticker: string,
  date: string,
  today: string,
): Promise<GreekHeatmapNetFlow | null> {
  const db = getDb();
  const isToday = date === today;

  // withDbRetry — same rationale as getGreekHeatmapSnapshot above.
  const rows = (await withDbRetry(
    () =>
      isToday
        ? db`
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
      `
        : db`
        SELECT
          ts,
          SUM(net_call_prem) OVER w AS cum_call_prem,
          SUM(net_call_vol)  OVER w AS cum_call_vol,
          SUM(net_put_prem)  OVER w AS cum_put_prem,
          SUM(net_put_vol)   OVER w AS cum_put_vol
        FROM net_flow_per_ticker_history
        WHERE ticker = ${ticker}
          AND date(ts) = ${date}::date
          AND source = 'rest'
        WINDOW w AS (PARTITION BY ticker, date(ts) ORDER BY ts)
        ORDER BY ts DESC
        LIMIT 1
      `,
    2,
    10000,
  )) as NetFlowRow[];

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

/**
 * Exported for direct unit testing — the null-vs-empty distinction
 * (Postgres aggregate returns one row with NULLs when zero source
 * rows exist) is easy to get wrong and worth covering.
 */
export function buildIntradayRange(
  range:
    | { first: string | null; last: string | null; distinct_count: number }
    | undefined,
): GreekHeatmapSnapshot['intradayRange'] {
  if (range?.first == null || range.last == null) return null;
  return {
    min: new Date(range.first).toISOString(),
    max: new Date(range.last).toISOString(),
    count: range.distinct_count,
  };
}
