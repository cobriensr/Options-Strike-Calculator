/**
 * Read helpers for the `ws_gex_strike_expiry` table populated by the
 * uw-stream daemon's `gex_strike_expiry:<TICKER>` WS handler.
 *
 * The panel use case is "give me the latest GEX per strike for this
 * ticker + expiry, optionally as of a specific minute for the
 * historical scrubber, with per-strike Δ% over the 1/5/10/15/30m
 * windows pre-computed." A 35-minute lookback CTE feeds `LAG()` window
 * functions so the GEX Landscape's Δ% columns populate on first paint
 * (no client-side ring-buffer warmup), then `DISTINCT ON (strike)`
 * collapses to the latest row per strike.
 *
 * Ingestion is daemon-owned (uw-stream UPSERTs every WS push); this
 * module is read-only.
 */

import { getDb } from './db.js';
import { parsedOrFallback } from './numeric-coercion.js';

export const GEX_STRIKE_EXPIRY_TICKERS = ['SPY', 'QQQ', 'SPX', 'NDX'] as const;
export type GexStrikeExpiryTicker = (typeof GEX_STRIKE_EXPIRY_TICKERS)[number];

type RawNumeric = string | number | null;

interface RawRow {
  ticker: string;
  expiry: string | Date;
  strike: string | number;
  ts_minute: string | Date;
  price: RawNumeric;
  call_gamma_oi: RawNumeric;
  put_gamma_oi: RawNumeric;
  call_charm_oi: RawNumeric;
  put_charm_oi: RawNumeric;
  call_vanna_oi: RawNumeric;
  put_vanna_oi: RawNumeric;
  call_gamma_vol: RawNumeric;
  put_gamma_vol: RawNumeric;
  call_charm_vol: RawNumeric;
  put_charm_vol: RawNumeric;
  call_vanna_vol: RawNumeric;
  put_vanna_vol: RawNumeric;
  call_gamma_ask_vol: RawNumeric;
  call_gamma_bid_vol: RawNumeric;
  put_gamma_ask_vol: RawNumeric;
  put_gamma_bid_vol: RawNumeric;
  call_charm_ask_vol: RawNumeric;
  call_charm_bid_vol: RawNumeric;
  put_charm_ask_vol: RawNumeric;
  put_charm_bid_vol: RawNumeric;
  call_vanna_ask_vol: RawNumeric;
  call_vanna_bid_vol: RawNumeric;
  put_vanna_ask_vol: RawNumeric;
  put_vanna_bid_vol: RawNumeric;
}

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

/**
 * Same row shape as `GexStrikeExpiryRow` plus per-strike Δ% (percent,
 * not ratio — e.g. `5` means +5%) over the 1m / 5m / 10m / 15m / 30m
 * lookback windows. Computed server-side via SQL `LAG()` windows so the
 * GEX Landscape's Δ% columns populate immediately on page load instead
 * of waiting on a client-side ring-buffer warmup.
 *
 * Each delta is `null` when there is no comparable prior row inside the
 * lookback window (e.g. early in the session, or after a producer gap).
 */
export interface GexStrikeExpiryRowWithDeltas extends GexStrikeExpiryRow {
  gamma_delta_1m: number | null;
  gamma_delta_5m: number | null;
  gamma_delta_10m: number | null;
  gamma_delta_15m: number | null;
  gamma_delta_30m: number | null;
}

function toIso(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function toExpiry(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function toNullableNumber(value: RawNumeric): number | null {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapRow(r: RawRow): GexStrikeExpiryRow {
  return {
    ticker: r.ticker as GexStrikeExpiryTicker,
    expiry: toExpiry(r.expiry),
    strike: parsedOrFallback(r.strike, 0),
    ts_minute: toIso(r.ts_minute),
    price: toNullableNumber(r.price),
    call_gamma_oi: toNullableNumber(r.call_gamma_oi),
    put_gamma_oi: toNullableNumber(r.put_gamma_oi),
    call_charm_oi: toNullableNumber(r.call_charm_oi),
    put_charm_oi: toNullableNumber(r.put_charm_oi),
    call_vanna_oi: toNullableNumber(r.call_vanna_oi),
    put_vanna_oi: toNullableNumber(r.put_vanna_oi),
    call_gamma_vol: toNullableNumber(r.call_gamma_vol),
    put_gamma_vol: toNullableNumber(r.put_gamma_vol),
    call_charm_vol: toNullableNumber(r.call_charm_vol),
    put_charm_vol: toNullableNumber(r.put_charm_vol),
    call_vanna_vol: toNullableNumber(r.call_vanna_vol),
    put_vanna_vol: toNullableNumber(r.put_vanna_vol),
    call_gamma_ask_vol: toNullableNumber(r.call_gamma_ask_vol),
    call_gamma_bid_vol: toNullableNumber(r.call_gamma_bid_vol),
    put_gamma_ask_vol: toNullableNumber(r.put_gamma_ask_vol),
    put_gamma_bid_vol: toNullableNumber(r.put_gamma_bid_vol),
    call_charm_ask_vol: toNullableNumber(r.call_charm_ask_vol),
    call_charm_bid_vol: toNullableNumber(r.call_charm_bid_vol),
    put_charm_ask_vol: toNullableNumber(r.put_charm_ask_vol),
    put_charm_bid_vol: toNullableNumber(r.put_charm_bid_vol),
    call_vanna_ask_vol: toNullableNumber(r.call_vanna_ask_vol),
    call_vanna_bid_vol: toNullableNumber(r.call_vanna_bid_vol),
    put_vanna_ask_vol: toNullableNumber(r.put_vanna_ask_vol),
    put_vanna_bid_vol: toNullableNumber(r.put_vanna_bid_vol),
  };
}

interface FetchOpts {
  ticker: GexStrikeExpiryTicker;
  expiry: string;
  /** Optional ISO timestamp; if provided, returns latest row per
   *  strike where ts_minute ≤ at. If omitted, returns latest per
   *  strike across the whole expiry day. */
  at?: string | null;
}

interface RawRowWithDeltas extends RawRow {
  gamma_delta_1m: RawNumeric;
  gamma_delta_5m: RawNumeric;
  gamma_delta_10m: RawNumeric;
  gamma_delta_15m: RawNumeric;
  gamma_delta_30m: RawNumeric;
}

function mapRowWithDeltas(r: RawRowWithDeltas): GexStrikeExpiryRowWithDeltas {
  return {
    ...mapRow(r),
    // SQL returns Δ as a ratio (e.g. 0.05 for +5%). Multiply by 100 so
    // the wire format matches `computeDeltaMap` from
    // `src/components/GexLandscape/deltas.ts`, which has always returned
    // percent. Downstream consumers (BiasPanel trends, StrikeTable Δ%
    // column, the maxChanged*Strike confluence markers) all assume
    // percent.
    gamma_delta_1m: scalePercent(r.gamma_delta_1m),
    gamma_delta_5m: scalePercent(r.gamma_delta_5m),
    gamma_delta_10m: scalePercent(r.gamma_delta_10m),
    gamma_delta_15m: scalePercent(r.gamma_delta_15m),
    gamma_delta_30m: scalePercent(r.gamma_delta_30m),
  };
}

function scalePercent(value: RawNumeric): number | null {
  const ratio = toNullableNumber(value);
  return ratio == null ? null : ratio * 100;
}

/**
 * Latest GEX row per strike for a (ticker, expiry), augmented with
 * per-strike Δ% over the 1m / 5m / 10m / 15m / 30m windows. Computed
 * via SQL `LAG()` over a 35-minute lookback CTE so the GEX Landscape's
 * Δ% columns populate on first paint instead of waiting on a
 * client-side buffer warmup.
 *
 * Optionally snapshotted to a specific timestamp via `at` (used by the
 * historical scrubber); when omitted, anchors at NOW(). The `at` window
 * filter applies to BOTH the visible row and the LAG history, so
 * scrubbing back returns deltas as they were at that minute.
 *
 * Strict-LAG assumption: `LAG(_, N)` is positional, not range-based.
 * With per-minute density (the expected case once the WS daemon has
 * been running through a session), `LAG(_, 5)` returns the row that is
 * exactly 5 minutes prior. If the producer drops minutes, `LAG(_, N)`
 * returns the Nth-prior ROW, which may be slightly older than N
 * minutes — an acceptable approximation for now. Density gaps will be
 * measured by `docs/tmp/gex-ticker-probe/density_probe.mjs`; if they
 * are material, swap to a tolerant range form
 * (`RANGE BETWEEN INTERVAL 'N min 30s' PRECEDING ...`).
 */
export async function getLatestGexPerStrikeWithDeltas(
  opts: FetchOpts,
): Promise<GexStrikeExpiryRowWithDeltas[]> {
  const sql = getDb();
  const { ticker, expiry, at } = opts;
  const atParam = at ?? null;

  // 35-minute lookback is enough to cover the largest delta (30m) plus
  // a small buffer absorbed by minor producer jitter. The CTE filters
  // first, then `LAG()` operates over per-strike partitions sorted
  // ascending. `DISTINCT ON (strike)` then collapses to the latest
  // row per strike (with deltas attached).
  //
  // `net_gamma::numeric` cast on the LAG ratio keeps division in the
  // numeric domain (Postgres integer division otherwise truncates).
  //
  // Historical fallback: SPX/NDX subscriptions only landed on the WS
  // daemon recently, so for any pre-cutover trading day the WS table
  // is empty. The legacy `gex_strike_0dte` cron has been populating
  // SPX 0DTE history all along, so we UNION ALL it under a gate:
  //   - `ws_count.n = 0`  → only fall through when WS has no rows
  //     for this (ticker, expiry, window). Prevents double-counting
  //     once the WS daemon catches up to the same minute.
  //   - `ticker = 'SPX'`  → the legacy table is SPX-only (no ticker
  //     column). Forcing this in the WHERE keeps SPY/QQQ/NDX queries
  //     from accidentally pulling SPX rows.
  // Column rename: legacy `call_gamma_ask` ↔ WS `call_gamma_ask_vol`
  // (same semantic — directional volume gamma — different column
  // name across schemas). Charm/vanna bid-ask vol fields don't exist
  // in the legacy table; we project them as `NULL::numeric` so the
  // UNION shape matches.
  //
  // Anchor for the 35-minute lookback: `effective_at`.
  //   - When `at` is provided (snapshot mode), use it directly.
  //   - When `at` is null (live mode), resolve to the latest
  //     `ts_minute` available across BOTH tables for this
  //     (ticker, expiry). Using NOW() breaks historical-date scrubbing
  //     because the requested expiry's data sits days behind NOW(), so
  //     `ts_minute >= NOW() - 35min` filters it all out.
  //   - Fall back to NOW() if both tables are empty (defensive — the
  //     downstream filters will return zero rows anyway).
  // Postgres `GREATEST` returns NULL only when ALL inputs are NULL;
  // it ignores NULLs alongside non-NULL values (verified on Neon
  // PG 17.8). The `CASE WHEN ${ticker}='SPX'` projects NULL for
  // non-SPX tickers, which `GREATEST` then ignores.
  const rows = (await sql`
    WITH effective_at AS (
      SELECT
        COALESCE(
          ${atParam}::timestamptz,
          GREATEST(
            (SELECT MAX(ts_minute) FROM ws_gex_strike_expiry
             WHERE ticker = ${ticker} AND expiry = ${expiry}::date),
            CASE WHEN ${ticker} = 'SPX' THEN
              (SELECT MAX(timestamp) FROM gex_strike_0dte
               WHERE date = ${expiry}::date)
            END
          ),
          NOW()
        ) AS at_ts
    ),
    ws_series AS (
      SELECT
        ticker, expiry, strike, ts_minute, price,
        call_gamma_oi, put_gamma_oi,
        call_charm_oi, put_charm_oi,
        call_vanna_oi, put_vanna_oi,
        call_gamma_vol, put_gamma_vol,
        call_charm_vol, put_charm_vol,
        call_vanna_vol, put_vanna_vol,
        call_gamma_ask_vol, call_gamma_bid_vol,
        put_gamma_ask_vol, put_gamma_bid_vol,
        call_charm_ask_vol, call_charm_bid_vol,
        put_charm_ask_vol, put_charm_bid_vol,
        call_vanna_ask_vol, call_vanna_bid_vol,
        put_vanna_ask_vol, put_vanna_bid_vol,
        (COALESCE(call_gamma_oi, 0) + COALESCE(put_gamma_oi, 0)) AS net_gamma
      FROM ws_gex_strike_expiry
      WHERE ticker = ${ticker}
        AND expiry = ${expiry}::date
        AND ts_minute >= (SELECT at_ts FROM effective_at) - INTERVAL '35 minutes'
        AND ts_minute <= (SELECT at_ts FROM effective_at)
    ),
    ws_count AS (
      SELECT COUNT(*) AS n FROM ws_series
    ),
    rest_series AS (
      SELECT
        'SPX'::text AS ticker,
        date AS expiry,
        strike, timestamp AS ts_minute, price,
        call_gamma_oi, put_gamma_oi,
        call_charm_oi, put_charm_oi,
        call_vanna_oi, put_vanna_oi,
        call_gamma_vol, put_gamma_vol,
        call_charm_vol, put_charm_vol,
        call_vanna_vol, put_vanna_vol,
        call_gamma_ask AS call_gamma_ask_vol,
        call_gamma_bid AS call_gamma_bid_vol,
        put_gamma_ask  AS put_gamma_ask_vol,
        put_gamma_bid  AS put_gamma_bid_vol,
        NULL::numeric AS call_charm_ask_vol,
        NULL::numeric AS call_charm_bid_vol,
        NULL::numeric AS put_charm_ask_vol,
        NULL::numeric AS put_charm_bid_vol,
        NULL::numeric AS call_vanna_ask_vol,
        NULL::numeric AS call_vanna_bid_vol,
        NULL::numeric AS put_vanna_ask_vol,
        NULL::numeric AS put_vanna_bid_vol,
        (COALESCE(call_gamma_oi, 0) + COALESCE(put_gamma_oi, 0)) AS net_gamma
      FROM gex_strike_0dte
      WHERE ${ticker} = 'SPX'
        AND (SELECT n FROM ws_count) = 0
        AND date = ${expiry}::date
        AND timestamp >= (SELECT at_ts FROM effective_at) - INTERVAL '35 minutes'
        AND timestamp <= (SELECT at_ts FROM effective_at)
    ),
    combined AS (
      SELECT * FROM ws_series
      UNION ALL
      SELECT * FROM rest_series
    ),
    deltas AS (
      SELECT
        ticker, expiry, strike, ts_minute, price,
        call_gamma_oi, put_gamma_oi,
        call_charm_oi, put_charm_oi,
        call_vanna_oi, put_vanna_oi,
        call_gamma_vol, put_gamma_vol,
        call_charm_vol, put_charm_vol,
        call_vanna_vol, put_vanna_vol,
        call_gamma_ask_vol, call_gamma_bid_vol,
        put_gamma_ask_vol, put_gamma_bid_vol,
        call_charm_ask_vol, call_charm_bid_vol,
        put_charm_ask_vol, put_charm_bid_vol,
        call_vanna_ask_vol, call_vanna_bid_vol,
        put_vanna_ask_vol, put_vanna_bid_vol,
        net_gamma,
        (net_gamma::numeric / NULLIF(ABS(LAG(net_gamma, 1)  OVER w), 0) - 1) AS gamma_delta_1m,
        (net_gamma::numeric / NULLIF(ABS(LAG(net_gamma, 5)  OVER w), 0) - 1) AS gamma_delta_5m,
        (net_gamma::numeric / NULLIF(ABS(LAG(net_gamma, 10) OVER w), 0) - 1) AS gamma_delta_10m,
        (net_gamma::numeric / NULLIF(ABS(LAG(net_gamma, 15) OVER w), 0) - 1) AS gamma_delta_15m,
        (net_gamma::numeric / NULLIF(ABS(LAG(net_gamma, 30) OVER w), 0) - 1) AS gamma_delta_30m
      FROM combined
      WINDOW w AS (PARTITION BY ticker, expiry, strike ORDER BY ts_minute)
    )
    SELECT DISTINCT ON (strike)
      ticker, expiry, strike, ts_minute, price,
      call_gamma_oi, put_gamma_oi,
      call_charm_oi, put_charm_oi,
      call_vanna_oi, put_vanna_oi,
      call_gamma_vol, put_gamma_vol,
      call_charm_vol, put_charm_vol,
      call_vanna_vol, put_vanna_vol,
      call_gamma_ask_vol, call_gamma_bid_vol,
      put_gamma_ask_vol, put_gamma_bid_vol,
      call_charm_ask_vol, call_charm_bid_vol,
      put_charm_ask_vol, put_charm_bid_vol,
      call_vanna_ask_vol, call_vanna_bid_vol,
      put_vanna_ask_vol, put_vanna_bid_vol,
      gamma_delta_1m, gamma_delta_5m, gamma_delta_10m,
      gamma_delta_15m, gamma_delta_30m
    FROM deltas
    ORDER BY strike, ts_minute DESC
  `) as RawRowWithDeltas[];
  return rows.map(mapRowWithDeltas);
}

/**
 * Distinct ts_minute values for (ticker, expiry), ascending. Used by the
 * /api/gex-strike-expiry endpoint to power the scrub control's prev/next
 * navigation — same role timestamps[] plays for /api/gex-per-strike.
 *
 * Mirrors the historical fallback in `getLatestGexPerStrikeWithDeltas`:
 * when WS has no rows for SPX on the requested expiry, fall through to
 * `gex_strike_0dte` (legacy SPX-only 0DTE table) so the scrubber works
 * on pre-cutover dates. The ws_count gate prevents double-listing once
 * the WS daemon has caught up.
 */
export async function getTimestampsForDay(
  ticker: GexStrikeExpiryTicker,
  expiry: string,
): Promise<string[]> {
  const sql = getDb();
  const rows = (await sql`
    WITH ws_ts AS (
      SELECT DISTINCT ts_minute
      FROM ws_gex_strike_expiry
      WHERE ticker = ${ticker}
        AND expiry = ${expiry}::date
    ),
    ws_count AS (
      SELECT COUNT(*) AS n FROM ws_ts
    ),
    rest_ts AS (
      SELECT DISTINCT timestamp AS ts_minute
      FROM gex_strike_0dte
      WHERE ${ticker} = 'SPX'
        AND (SELECT n FROM ws_count) = 0
        AND date = ${expiry}::date
    )
    SELECT ts_minute FROM ws_ts
    UNION
    SELECT ts_minute FROM rest_ts
    ORDER BY ts_minute ASC
  `) as Array<{ ts_minute: string | Date }>;
  return rows.map((r) => toIso(r.ts_minute));
}
