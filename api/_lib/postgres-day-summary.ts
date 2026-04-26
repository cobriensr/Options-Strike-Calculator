/**
 * Postgres-fed fallbacks for sidecar-archive endpoints. Used by the
 * embed-yesterday and fetch-day-ohlc crons when the sidecar has no row
 * for a date — usually because a fresh Databento batch hasn't been
 * converted and uploaded to Vercel Blob yet, so the sidecar's
 * `/data/archive` volume hasn't been reseeded.
 *
 * The streaming Schwab → `spx_candles_1m` feed lands in Postgres in
 * real-time, so this path closes the parquet-lag window (~7 days)
 * without manual intervention. When the parquet eventually catches up,
 * the cron writes are idempotent: subsequent runs overwrite via
 * upsert/UPDATE, restoring the canonical ES-sourced values.
 *
 * Two helpers:
 *   - `fetchDaySummaryFromPostgres` — formatted text summary for the
 *     embedding pipeline; matches sidecar's `day_summary_text()` byte
 *     format (only the symbol token differs: "SPX" vs an ES contract
 *     code). Same format means the same vector space for analog
 *     retrieval; symbol divergence is the honesty signal.
 *   - `fetchDayOhlcFromPostgres` — structured OHLC + simple excursion
 *     metrics for the day_embeddings OHLC columns. Same value
 *     conventions as the sidecar's `?? high - open` / `?? open - low`
 *     fallbacks already used in fetch-day-ohlc.
 */

import { getDb } from './db.js';
import logger from './logger.js';

// Neon returns NUMERIC columns as strings (full precision) and FLOAT8 as
// numbers; nulls flow through. Accept all three so callers don't trip on
// driver-level type changes.
type Numeric = string | number | null;

interface DayAggregate {
  day_open: Numeric;
  day_high: Numeric;
  day_low: Numeric;
  day_close: Numeric;
  day_volume: Numeric;
  close_60: Numeric;
  close_120: Numeric;
  close_180: Numeric;
}

function formatVolume(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return Math.floor(v).toString();
}

function formatDelta(d: number | null): string {
  if (d === null || !Number.isFinite(d)) return 'n/a';
  const sign = d >= 0 ? '+' : '';
  return `${sign}${d.toFixed(2)}`;
}

/**
 * Build a day-summary string from `spx_candles_1m` for `dateIso`.
 * Returns null when no regular-hours bars exist for the date.
 *
 * The first regular-hours bar's `timestamp` anchors the session start,
 * and 1h/2h/3h delta checkpoints are the *last* close at or before
 * `session_open + 60/120/180 minutes`. This mirrors the sidecar's
 * DuckDB query semantics so summaries are comparable across sources.
 */
export async function fetchDaySummaryFromPostgres(
  dateIso: string,
): Promise<string | null> {
  const sql = getDb();
  try {
    const rows = (await sql`
      WITH bars AS (
        SELECT timestamp, open, high, low, close, volume
        FROM spx_candles_1m
        WHERE date = ${dateIso}::date
          AND market_time = 'r'
      ),
      anchor AS (
        SELECT MIN(timestamp) AS session_open FROM bars
      )
      SELECT
        (SELECT open  FROM bars ORDER BY timestamp ASC  LIMIT 1)::float8 AS day_open,
        (SELECT MAX(high) FROM bars)::float8                              AS day_high,
        (SELECT MIN(low)  FROM bars)::float8                              AS day_low,
        (SELECT close FROM bars ORDER BY timestamp DESC LIMIT 1)::float8 AS day_close,
        (SELECT SUM(volume) FROM bars)::float8                           AS day_volume,
        (SELECT close FROM bars
         WHERE timestamp <= (SELECT session_open FROM anchor) + INTERVAL '60 minutes'
         ORDER BY timestamp DESC LIMIT 1)::float8 AS close_60,
        (SELECT close FROM bars
         WHERE timestamp <= (SELECT session_open FROM anchor) + INTERVAL '120 minutes'
         ORDER BY timestamp DESC LIMIT 1)::float8 AS close_120,
        (SELECT close FROM bars
         WHERE timestamp <= (SELECT session_open FROM anchor) + INTERVAL '180 minutes'
         ORDER BY timestamp DESC LIMIT 1)::float8 AS close_180
    `) as DayAggregate[];

    const r = rows[0];
    if (r?.day_open == null) return null;

    const dayOpen = Number(r.day_open);
    const dayHigh = Number(r.day_high);
    const dayLow = Number(r.day_low);
    const dayClose = Number(r.day_close);
    const dayVolume = Number(r.day_volume);
    const close60 = r.close_60 !== null ? Number(r.close_60) : null;
    const close120 = r.close_120 !== null ? Number(r.close_120) : null;
    const close180 = r.close_180 !== null ? Number(r.close_180) : null;

    if (
      ![dayOpen, dayHigh, dayLow, dayClose, dayVolume].every((v) =>
        Number.isFinite(v),
      )
    ) {
      return null;
    }

    const d1 = close60 !== null ? close60 - dayOpen : null;
    const d2 = close120 !== null ? close120 - dayOpen : null;
    const d3 = close180 !== null ? close180 - dayOpen : null;

    const range = dayHigh - dayLow;
    const closeMinusOpen = dayClose - dayOpen;
    const closeSign = closeMinusOpen >= 0 ? '+' : '';

    return (
      `${dateIso} SPX | ` +
      `open ${dayOpen.toFixed(2)} | ` +
      `1h delta ${formatDelta(d1)} | ` +
      `2h delta ${formatDelta(d2)} | ` +
      `3h delta ${formatDelta(d3)} | ` +
      `range ${range.toFixed(2)} | ` +
      `vol ${formatVolume(dayVolume)} | ` +
      `close ${dayClose.toFixed(2)} ` +
      `(${closeSign}${closeMinusOpen.toFixed(2)})`
    );
  } catch (err) {
    logger.warn({ err, date: dateIso }, 'fetchDaySummaryFromPostgres failed');
    return null;
  }
}

export interface DayOhlc {
  open: number;
  high: number;
  low: number;
  close: number;
  range: number;
  up_excursion: number;
  down_excursion: number;
}

/**
 * Aggregate `spx_candles_1m` regular-hours bars to a day's OHLC plus
 * simple excursion metrics for the `day_embeddings` OHLC columns.
 * Returns null when the day has no bars.
 *
 * `up_excursion` / `down_excursion` use the simple definitions
 * (`high - open`, `open - low`) — the same fallback that fetch-day-ohlc
 * already applies when the sidecar omits these fields. Path-dependent
 * "running excursion" semantics are deferred to the canonical sidecar
 * source; the row gets overwritten when the parquet catches up.
 */
export async function fetchDayOhlcFromPostgres(
  dateIso: string,
): Promise<DayOhlc | null> {
  const sql = getDb();
  try {
    const rows = (await sql`
      SELECT
        (SELECT open FROM spx_candles_1m
         WHERE date = ${dateIso}::date AND market_time = 'r'
         ORDER BY timestamp ASC LIMIT 1)::float8                AS day_open,
        (SELECT MAX(high)::float8 FROM spx_candles_1m
         WHERE date = ${dateIso}::date AND market_time = 'r')   AS day_high,
        (SELECT MIN(low)::float8 FROM spx_candles_1m
         WHERE date = ${dateIso}::date AND market_time = 'r')   AS day_low,
        (SELECT close FROM spx_candles_1m
         WHERE date = ${dateIso}::date AND market_time = 'r'
         ORDER BY timestamp DESC LIMIT 1)::float8               AS day_close
    `) as {
      day_open: Numeric;
      day_high: Numeric;
      day_low: Numeric;
      day_close: Numeric;
    }[];

    const r = rows[0];
    if (r?.day_open == null) return null;

    const open = Number(r.day_open);
    const high = Number(r.day_high);
    const low = Number(r.day_low);
    const close = Number(r.day_close);
    if (![open, high, low, close].every((v) => Number.isFinite(v))) return null;

    return {
      open,
      high,
      low,
      close,
      range: high - low,
      up_excursion: high - open,
      down_excursion: open - low,
    };
  } catch (err) {
    logger.warn({ err, date: dateIso }, 'fetchDayOhlcFromPostgres failed');
    return null;
  }
}
