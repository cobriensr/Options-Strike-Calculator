/**
 * Read helpers for the `ws_gex_strike_expiry` table populated by the
 * uw-stream daemon's `gex_strike_expiry:<TICKER>` WS handler.
 *
 * The panel use case is "give me the latest GEX per strike for this
 * ticker + expiry, optionally as of a specific minute for the
 * historical scrubber." That maps to a single SELECT with DISTINCT ON
 * over (strike) ordered by ts_minute DESC.
 *
 * Ingestion is daemon-owned (uw-stream UPSERTs every WS push); this
 * module is read-only.
 */

import { getDb } from './db.js';
import { parsedOrFallback } from './numeric-coercion.js';

export const GEX_STRIKE_EXPIRY_TICKERS = ['SPY', 'QQQ'] as const;
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

/**
 * Latest GEX row per strike for a (ticker, expiry) — optionally
 * snapshotted to a specific timestamp via `at` (used by the historical
 * scrubber). Strikes are returned ordered ASC so the panel can render
 * them left-to-right without a client-side sort.
 */
export async function getLatestGexPerStrike(
  opts: FetchOpts,
): Promise<GexStrikeExpiryRow[]> {
  const sql = getDb();
  const { ticker, expiry, at } = opts;

  if (at) {
    const rows = (await sql`
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
        put_vanna_ask_vol, put_vanna_bid_vol
      FROM ws_gex_strike_expiry
      WHERE ticker = ${ticker}
        AND expiry = ${expiry}::date
        AND ts_minute <= ${at}::timestamptz
      ORDER BY strike, ts_minute DESC
    `) as RawRow[];
    return rows.map(mapRow);
  }

  const rows = (await sql`
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
      put_vanna_ask_vol, put_vanna_bid_vol
    FROM ws_gex_strike_expiry
    WHERE ticker = ${ticker}
      AND expiry = ${expiry}::date
    ORDER BY strike, ts_minute DESC
  `) as RawRow[];
  return rows.map(mapRow);
}
