/**
 * Read helpers for the `vega_flow_etf` table populated by
 * `fetch-greek-flow-etf` (UW /stock/{ticker}/greek-flow, 1-min bars,
 * SPY + QQQ).
 *
 * Cumulative columns are computed in the query via window functions
 * (`SUM(...) OVER (PARTITION BY ticker ORDER BY timestamp)`) so the
 * cumulative is always derived from raw rows — no precomputed columns
 * to keep in sync with replays / late inserts.
 */

import { getDb } from './db.js';
import { parsedOrFallback } from './numeric-coercion.js';

export const GREEK_FLOW_TICKERS = ['SPY', 'QQQ'] as const;
export type GreekFlowTicker = (typeof GREEK_FLOW_TICKERS)[number];

export const GREEK_FLOW_FIELDS = [
  'dir_vega_flow',
  'total_vega_flow',
  'otm_dir_vega_flow',
  'otm_total_vega_flow',
  'dir_delta_flow',
  'total_delta_flow',
  'otm_dir_delta_flow',
  'otm_total_delta_flow',
] as const;
export type GreekFlowField = (typeof GREEK_FLOW_FIELDS)[number];

interface RawGreekFlowRow {
  ticker: string;
  timestamp: string | Date;
  transactions: string | number;
  volume: string | number;
  dir_vega_flow: string | number;
  total_vega_flow: string | number;
  otm_dir_vega_flow: string | number;
  otm_total_vega_flow: string | number;
  dir_delta_flow: string | number;
  total_delta_flow: string | number;
  otm_dir_delta_flow: string | number;
  otm_total_delta_flow: string | number;
  cum_dir_vega_flow: string | number;
  cum_total_vega_flow: string | number;
  cum_otm_dir_vega_flow: string | number;
  cum_otm_total_vega_flow: string | number;
  cum_dir_delta_flow: string | number;
  cum_total_delta_flow: string | number;
  cum_otm_dir_delta_flow: string | number;
  cum_otm_total_delta_flow: string | number;
  /** Per-minute close from etf_candles_1m. NULL when the candle is missing. */
  price?: string | number | null;
}

export interface GreekFlowRow {
  ticker: GreekFlowTicker;
  timestamp: string;
  transactions: number;
  volume: number;
  dir_vega_flow: number;
  total_vega_flow: number;
  otm_dir_vega_flow: number;
  otm_total_vega_flow: number;
  dir_delta_flow: number;
  total_delta_flow: number;
  otm_dir_delta_flow: number;
  otm_total_delta_flow: number;
  cum_dir_vega_flow: number;
  cum_total_vega_flow: number;
  cum_otm_dir_vega_flow: number;
  cum_otm_total_vega_flow: number;
  cum_dir_delta_flow: number;
  cum_total_delta_flow: number;
  cum_otm_dir_delta_flow: number;
  cum_otm_total_delta_flow: number;
  /** Underlying ETF close at this minute (null when no matching candle). */
  price: number | null;
}

function toIso(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function mapRow(r: RawGreekFlowRow): GreekFlowRow {
  return {
    ticker: r.ticker as GreekFlowTicker,
    timestamp: toIso(r.timestamp),
    transactions: parsedOrFallback(r.transactions, 0),
    volume: parsedOrFallback(r.volume, 0),
    dir_vega_flow: parsedOrFallback(r.dir_vega_flow, 0),
    total_vega_flow: parsedOrFallback(r.total_vega_flow, 0),
    otm_dir_vega_flow: parsedOrFallback(r.otm_dir_vega_flow, 0),
    otm_total_vega_flow: parsedOrFallback(r.otm_total_vega_flow, 0),
    dir_delta_flow: parsedOrFallback(r.dir_delta_flow, 0),
    total_delta_flow: parsedOrFallback(r.total_delta_flow, 0),
    otm_dir_delta_flow: parsedOrFallback(r.otm_dir_delta_flow, 0),
    otm_total_delta_flow: parsedOrFallback(r.otm_total_delta_flow, 0),
    cum_dir_vega_flow: parsedOrFallback(r.cum_dir_vega_flow, 0),
    cum_total_vega_flow: parsedOrFallback(r.cum_total_vega_flow, 0),
    cum_otm_dir_vega_flow: parsedOrFallback(r.cum_otm_dir_vega_flow, 0),
    cum_otm_total_vega_flow: parsedOrFallback(r.cum_otm_total_vega_flow, 0),
    cum_dir_delta_flow: parsedOrFallback(r.cum_dir_delta_flow, 0),
    cum_total_delta_flow: parsedOrFallback(r.cum_total_delta_flow, 0),
    cum_otm_dir_delta_flow: parsedOrFallback(r.cum_otm_dir_delta_flow, 0),
    cum_otm_total_delta_flow: parsedOrFallback(r.cum_otm_total_delta_flow, 0),
    price: parseNullableNumeric(r.price),
  };
}

function parseNullableNumeric(
  value: string | number | null | undefined,
): number | null {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Resolve which ET calendar date to query.
 *
 * When `date` is provided, it's used as-is (validated upstream by Zod).
 * When omitted, returns the latest distinct `date` value present in
 * `vega_flow_etf` for SPY (which always co-fires with QQQ in the cron),
 * or `null` if the table is empty.
 */
export async function resolveLatestGreekFlowDate(
  date: string | null,
): Promise<string | null> {
  if (date) return date;
  const sql = getDb();
  const rows = (await sql`
    SELECT date::text AS d
    FROM vega_flow_etf
    WHERE ticker = 'SPY'
    ORDER BY date DESC
    LIMIT 1
  `) as { d: string }[];
  return rows[0]?.d ?? null;
}

/**
 * Returns SPY + QQQ rows for `date`, ordered by ticker then timestamp,
 * with cumulative columns added via Postgres window functions.
 *
 * Empty array if the date has no rows (returned as-is — caller decides
 * whether that's an error or just "before market open").
 */
export async function getGreekFlowSession(
  date: string,
): Promise<GreekFlowRow[]> {
  const sql = getDb();
  const rows = (await sql`
    SELECT
      f.ticker,
      f.timestamp,
      f.transactions,
      f.volume,
      f.dir_vega_flow,
      f.total_vega_flow,
      f.otm_dir_vega_flow,
      f.otm_total_vega_flow,
      f.dir_delta_flow,
      f.total_delta_flow,
      f.otm_dir_delta_flow,
      f.otm_total_delta_flow,
      SUM(f.dir_vega_flow)        OVER w AS cum_dir_vega_flow,
      SUM(f.total_vega_flow)      OVER w AS cum_total_vega_flow,
      SUM(f.otm_dir_vega_flow)    OVER w AS cum_otm_dir_vega_flow,
      SUM(f.otm_total_vega_flow)  OVER w AS cum_otm_total_vega_flow,
      SUM(f.dir_delta_flow)       OVER w AS cum_dir_delta_flow,
      SUM(f.total_delta_flow)     OVER w AS cum_total_delta_flow,
      SUM(f.otm_dir_delta_flow)   OVER w AS cum_otm_dir_delta_flow,
      SUM(f.otm_total_delta_flow) OVER w AS cum_otm_total_delta_flow,
      c.close AS price
    FROM vega_flow_etf f
    LEFT JOIN etf_candles_1m c
      ON c.ticker = f.ticker
     AND c.timestamp = f.timestamp
    WHERE f.ticker IN ('SPY', 'QQQ')
      AND f.date = ${date}::date
    WINDOW w AS (PARTITION BY f.ticker ORDER BY f.timestamp)
    ORDER BY f.ticker, f.timestamp
  `) as RawGreekFlowRow[];
  return rows.map(mapRow);
}

/**
 * Splits a flat session into per-ticker arrays. The query returns rows
 * ordered by ticker then timestamp so this is a single-pass partition.
 */
export function splitByTicker(
  rows: GreekFlowRow[],
): Record<GreekFlowTicker, GreekFlowRow[]> {
  const out: Record<GreekFlowTicker, GreekFlowRow[]> = { SPY: [], QQQ: [] };
  for (const row of rows) {
    if (row.ticker === 'SPY' || row.ticker === 'QQQ') {
      out[row.ticker].push(row);
    }
  }
  return out;
}
