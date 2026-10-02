/**
 * Postgres-fed day reads for the analog crons (embed-yesterday,
 * fetch-day-ohlc). The sidecar archive is frozen at 2026-04-17, so for
 * every new date these are the only source: the streaming Schwab →
 * `index_candles_1m (SPX)` feed lands in Postgres in real time.
 *
 * Helpers:
 *   - `fetchDaySummaryFromPostgres` — formatted text summary for the
 *     embedding pipeline; matches sidecar's `day_summary_text()` byte
 *     format (only the symbol token differs: "SPX" vs an ES contract
 *     code). Same format means the same vector space for analog
 *     retrieval; symbol divergence is the honesty signal.
 *   - `readDayOhlcFromPostgres` — structured OHLC + simple excursion
 *     metrics for the day_embeddings OHLC columns. Same value
 *     conventions as the sidecar's `?? high - open` / `?? open - low`
 *     fallbacks already used in fetch-day-ohlc.
 *   - `fetchDayOhlcFromPostgres` — the fail-soft (null on DB error)
 *     wrapper the regime-0DTE scorecard relies on.
 *   - `fetchVixCloseFromPostgres` — the day's VIX close from `outcomes`.
 *
 * The summary and OHLC reads also return the number of regular-session
 * bars so a caller can refuse a partial day (a feed that died mid-
 * session leaves a day that looks complete but is not). They throw on a
 * DB error: a cron that turned a rejected query into "no data" would
 * report a skip instead of a failure.
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
  bar_count: Numeric;
}

export interface DaySummaryRead {
  summary: string;
  /** Regular-session (`market_time = 'r'`) one-minute bars found. */
  barCount: number;
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
 * Build a day-summary string from `index_candles_1m (SPX)` for `dateIso`.
 * Returns null when no regular-hours bars exist for the date. Throws on
 * a DB error.
 *
 * The first regular-hours bar's `timestamp` anchors the session start,
 * and 1h/2h/3h delta checkpoints are the *last* close at or before
 * `session_open + 60/120/180 minutes`. This mirrors the sidecar's
 * DuckDB query semantics so summaries are comparable across sources.
 */
export async function fetchDaySummaryFromPostgres(
  dateIso: string,
): Promise<DaySummaryRead | null> {
  const sql = getDb();
  const rows = (await sql`
    WITH bars AS (
      SELECT timestamp, open, high, low, close, volume
      FROM index_candles_1m
      WHERE symbol = 'SPX'
        AND date = ${dateIso}::date
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
       ORDER BY timestamp DESC LIMIT 1)::float8 AS close_180,
      (SELECT COUNT(*) FROM bars)::int AS bar_count
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

  return {
    summary:
      `${dateIso} SPX | ` +
      `open ${dayOpen.toFixed(2)} | ` +
      `1h delta ${formatDelta(d1)} | ` +
      `2h delta ${formatDelta(d2)} | ` +
      `3h delta ${formatDelta(d3)} | ` +
      `range ${range.toFixed(2)} | ` +
      `vol ${formatVolume(dayVolume)} | ` +
      `close ${dayClose.toFixed(2)} ` +
      `(${closeSign}${closeMinusOpen.toFixed(2)})`,
    barCount: Number(r.bar_count ?? 0),
  };
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

export interface DayOhlcRead {
  ohlc: DayOhlc;
  /** Regular-session (`market_time = 'r'`) one-minute bars found. */
  barCount: number;
}

/**
 * Aggregate `index_candles_1m (SPX)` regular-hours bars to a day's OHLC plus
 * simple excursion metrics for the `day_embeddings` OHLC columns.
 * Returns null when the day has no bars; throws on a DB error.
 *
 * `up_excursion` / `down_excursion` use the simple definitions
 * (`high - open`, `open - low`) — the same fallback that fetch-day-ohlc
 * already applies when the sidecar omits these fields.
 */
export async function readDayOhlcFromPostgres(
  dateIso: string,
): Promise<DayOhlcRead | null> {
  const sql = getDb();
  const rows = (await sql`
    WITH bars AS (
      SELECT timestamp, open, high, low, close
      FROM index_candles_1m
      WHERE symbol = 'SPX' AND date = ${dateIso}::date AND market_time = 'r'
    )
    SELECT
      (SELECT open  FROM bars ORDER BY timestamp ASC  LIMIT 1)::float8 AS day_open,
      (SELECT MAX(high) FROM bars)::float8                              AS day_high,
      (SELECT MIN(low)  FROM bars)::float8                              AS day_low,
      (SELECT close FROM bars ORDER BY timestamp DESC LIMIT 1)::float8 AS day_close,
      (SELECT COUNT(*) FROM bars)::int                                  AS bar_count
  `) as {
    day_open: Numeric;
    day_high: Numeric;
    day_low: Numeric;
    day_close: Numeric;
    bar_count: Numeric;
  }[];

  const r = rows[0];
  if (r?.day_open == null) return null;

  const open = Number(r.day_open);
  const high = Number(r.day_high);
  const low = Number(r.day_low);
  const close = Number(r.day_close);
  if (![open, high, low, close].every((v) => Number.isFinite(v))) return null;

  return {
    ohlc: {
      open,
      high,
      low,
      close,
      range: high - low,
      up_excursion: high - open,
      down_excursion: open - low,
    },
    barCount: Number(r.bar_count ?? 0),
  };
}

/**
 * Fail-soft day OHLC: null when the day has no bars OR the query fails.
 * For the regime-0DTE scorecard, which records a null outcome rather
 * than failing its run. Crons that write analog labels use
 * `readDayOhlcFromPostgres` so a DB reject surfaces.
 */
export async function fetchDayOhlcFromPostgres(
  dateIso: string,
): Promise<DayOhlc | null> {
  try {
    const read = await readDayOhlcFromPostgres(dateIso);
    return read?.ohlc ?? null;
  } catch (err) {
    logger.warn({ err, date: dateIso }, 'fetchDayOhlcFromPostgres failed');
    return null;
  }
}

/**
 * The day's VIX close from `outcomes` (written by fetch-outcomes after
 * the close), or null when that row or value is missing. Throws on a
 * DB error.
 */
export async function fetchVixCloseFromPostgres(
  dateIso: string,
): Promise<number | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT vix_close::float8 AS vix_close
    FROM outcomes
    WHERE date = ${dateIso}::date
  `) as { vix_close: Numeric }[];
  const raw = rows[0]?.vix_close;
  if (raw == null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
