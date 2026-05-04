/**
 * Shared dark-pool query helper.
 *
 * Reads aggregated dark-pool levels from the `dark_pool_prints` table
 * (raw per-print rows written by the uw-stream daemon's
 * off_lit_trades handler) and synthesizes index-equivalent views for
 * SPX and NDX selectors via the contemporaneous candle ratio in
 * `index_candles_1m`.
 *
 * Selector → backing data:
 *   SPX  → SPY prints × (SPX_close / SPY_close) per minute candle
 *   NDX  → QQQ prints × (NDX_close / QQQ_close) per minute candle
 *   SPY  → SPY prints, native price level (no ratio)
 *   QQQ  → QQQ prints, native price level (no ratio)
 *
 * Phase 7 cutover (commit d1a14162 + this file's simplification): the
 * legacy `dark_pool_levels` table and its fetch-darkpool cron are
 * gone; this helper is daemon-only. The previous USE_DAEMON_DARK_POOL
 * env-flag soak gate has been removed entirely.
 */

import type { NeonQueryFunction } from '@neondatabase/serverless';
import { getDb } from './db.js';

export type DarkPoolSymbol = 'SPX' | 'NDX' | 'SPY' | 'QQQ';

export interface DarkPoolLevel {
  /** Index-equivalent price level (SPX-approx for SPX, native for ETFs). */
  level: number;
  /** SUM(price × size) across all aggregated prints at this level. */
  totalPremium: number;
  /** Number of prints aggregated into this level. */
  tradeCount: number;
  /** SUM(size) across all aggregated prints. */
  totalShares: number;
  /** Most recent print timestamp at this level. */
  latestTime: string;
  /** Most recent ingest write into the underlying table. */
  updatedAt: string | null;
}

export interface DarkPoolLevelsResult {
  levels: DarkPoolLevel[];
  /** Most recent ingest write timestamp across all levels for this date. */
  lastUpdated: string | null;
}

interface SelectorConfig {
  /** The ETF whose prints are stored in dark_pool_prints. */
  etfTicker: 'SPY' | 'QQQ';
  /** The index symbol to look up in index_candles_1m for the ratio.
   *  null = native ETF view (no ratio scaling). */
  indexSymbol: 'SPX' | 'NDX' | null;
}

const SELECTOR_CONFIGS: Record<DarkPoolSymbol, SelectorConfig> = {
  SPX: { etfTicker: 'SPY', indexSymbol: 'SPX' },
  NDX: { etfTicker: 'QQQ', indexSymbol: 'NDX' },
  SPY: { etfTicker: 'SPY', indexSymbol: null },
  QQQ: { etfTicker: 'QQQ', indexSymbol: null },
};

type RawNumeric = string | number;
type Timestampish = string | Date | null;
type RequiredTimestampish = string | Date;

interface PrintsRow {
  level: RawNumeric;
  total_premium: RawNumeric;
  trade_count: RawNumeric;
  total_shares: RawNumeric;
  latest_time: RequiredTimestampish;
  updated_at: Timestampish;
  max_updated_at: Timestampish;
}

function isoOrString(v: Timestampish): string | null {
  if (v === null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function isoOrStringNonNull(v: RequiredTimestampish): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

/**
 * Fetch dark-pool aggregated levels for a date, optionally filtered to
 * "as of" a wall-clock CT time (only include prints executed at or
 * before that time on the requested date).
 *
 * The aggregation is done in a single SQL query; per-print fidelity is
 * preserved in `dark_pool_prints` and only the level-bucketing is
 * computed at read time. This means the mapping methodology can change
 * (e.g. switch ratio source from minute candles to second-resolution)
 * without a backfill.
 */
export async function getDarkPoolLevels(opts: {
  date: string;
  symbol: DarkPoolSymbol;
  asOfTimeCT?: string; // 'HH:MM' — optional time filter
}): Promise<DarkPoolLevelsResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) {
    throw new Error(`Invalid date for getDarkPoolLevels: ${opts.date}`);
  }

  const sql = getDb();
  const config = SELECTOR_CONFIGS[opts.symbol];
  const printsRows = await queryPrints(sql, {
    date: opts.date,
    config,
    asOfTimeCT: opts.asOfTimeCT,
  });

  return {
    levels: printsRows.map(transformPrintsRow),
    lastUpdated:
      printsRows.length > 0 ? isoOrString(printsRows[0]!.max_updated_at) : null,
  };
}

async function queryPrints(
  sql: NeonQueryFunction<false, false>,
  opts: {
    date: string;
    config: SelectorConfig;
    asOfTimeCT?: string;
  },
): Promise<PrintsRow[]> {
  const { date, config, asOfTimeCT } = opts;
  const { etfTicker, indexSymbol } = config;

  // Index-mapped selector: JOIN both ETF + index candle tables and use
  // the contemporaneous ratio for each minute's prints.
  if (indexSymbol !== null) {
    if (asOfTimeCT && /^\d{2}:\d{2}$/.test(asOfTimeCT)) {
      return (await sql`
        WITH agg AS (
          SELECT
            ROUND(p.price * (i.close / e.close))::int AS level,
            SUM(p.premium) AS total_premium,
            COUNT(*) AS trade_count,
            SUM(p.size) AS total_shares,
            MAX(p.executed_at) AS latest_time,
            MAX(p.ingested_at) AS updated_at
          FROM dark_pool_prints p
          JOIN etf_candles_1m e
            ON e.ticker = ${etfTicker}
            AND e.timestamp = date_trunc('minute', p.executed_at)
          JOIN index_candles_1m i
            ON i.symbol = ${indexSymbol}
            AND i.timestamp = date_trunc('minute', p.executed_at)
          WHERE p.symbol = ${etfTicker}
            AND p.date = ${date}
            AND p.executed_at <= (${`${date} ${asOfTimeCT}:00`}::timestamp AT TIME ZONE 'America/Chicago')
            AND e.close > 0
            AND i.close > 0
          GROUP BY 1
        )
        SELECT level, total_premium, trade_count, total_shares,
               latest_time, updated_at,
               MAX(updated_at) OVER () AS max_updated_at
        FROM agg
        ORDER BY total_premium DESC
      `) as PrintsRow[];
    }
    return (await sql`
      WITH agg AS (
        SELECT
          ROUND(p.price * (i.close / e.close))::int AS level,
          SUM(p.premium) AS total_premium,
          COUNT(*) AS trade_count,
          SUM(p.size) AS total_shares,
          MAX(p.executed_at) AS latest_time,
          MAX(p.ingested_at) AS updated_at
        FROM dark_pool_prints p
        JOIN etf_candles_1m e
          ON e.ticker = ${etfTicker}
          AND e.timestamp = date_trunc('minute', p.executed_at)
        JOIN index_candles_1m i
          ON i.symbol = ${indexSymbol}
          AND i.timestamp = date_trunc('minute', p.executed_at)
        WHERE p.symbol = ${etfTicker}
          AND p.date = ${date}
          AND e.close > 0
          AND i.close > 0
        GROUP BY 1
      )
      SELECT level, total_premium, trade_count, total_shares,
             latest_time, updated_at,
             MAX(updated_at) OVER () AS max_updated_at
      FROM agg
      ORDER BY total_premium DESC
    `) as PrintsRow[];
  }

  // Native ETF selector — no candle JOIN, just bucket by rounded price.
  if (asOfTimeCT && /^\d{2}:\d{2}$/.test(asOfTimeCT)) {
    return (await sql`
      WITH agg AS (
        SELECT
          ROUND(p.price)::int AS level,
          SUM(p.premium) AS total_premium,
          COUNT(*) AS trade_count,
          SUM(p.size) AS total_shares,
          MAX(p.executed_at) AS latest_time,
          MAX(p.ingested_at) AS updated_at
        FROM dark_pool_prints p
        WHERE p.symbol = ${etfTicker}
          AND p.date = ${date}
          AND p.executed_at <= (${`${date} ${asOfTimeCT}:00`}::timestamp AT TIME ZONE 'America/Chicago')
        GROUP BY 1
      )
      SELECT level, total_premium, trade_count, total_shares,
             latest_time, updated_at,
             MAX(updated_at) OVER () AS max_updated_at
      FROM agg
      ORDER BY total_premium DESC
    `) as PrintsRow[];
  }
  return (await sql`
    WITH agg AS (
      SELECT
        ROUND(p.price)::int AS level,
        SUM(p.premium) AS total_premium,
        COUNT(*) AS trade_count,
        SUM(p.size) AS total_shares,
        MAX(p.executed_at) AS latest_time,
        MAX(p.ingested_at) AS updated_at
      FROM dark_pool_prints p
      WHERE p.symbol = ${etfTicker}
        AND p.date = ${date}
      GROUP BY 1
    )
    SELECT level, total_premium, trade_count, total_shares,
           latest_time, updated_at,
           MAX(updated_at) OVER () AS max_updated_at
    FROM agg
    ORDER BY total_premium DESC
  `) as PrintsRow[];
}

function transformPrintsRow(r: PrintsRow): DarkPoolLevel {
  return {
    level: Number(r.level),
    totalPremium: Number(r.total_premium),
    tradeCount: Number(r.trade_count),
    totalShares: Number(r.total_shares),
    latestTime: isoOrStringNonNull(r.latest_time),
    updatedAt: isoOrString(r.updated_at),
  };
}

// ──────────────────────────────────────────────────────────────────
// Additional consumer-specific helpers
// ──────────────────────────────────────────────────────────────────

/**
 * Most recent ingest timestamp for the dark-pool data — used by the
 * system-status freshness check. Daemon writes one row per print, so
 * a healthy session produces sub-second freshness.
 */
export async function getDarkPoolLastUpdated(): Promise<string | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT MAX(ingested_at) AS ts
    FROM dark_pool_prints
    WHERE symbol IN ('SPY', 'QQQ')
  `) as Array<{ ts: Timestampish }>;
  const ts = rows[0]?.ts;
  return ts == null ? null : isoOrString(ts);
}

export interface RecentDarkPoolPrint {
  /** ISO-8601 timestamp of the print. */
  ts: string;
  /** Index-equivalent price (SPX-approx for SPX selector). */
  price: number;
  /** Premium in dollars (per-print). */
  premium: number;
}

/**
 * Recent dark-pool activity for the analyze anomaly context. Returns
 * up to `limit` rows from the time window [fromIso, toIso] sorted by
 * timestamp DESC. SPX/NDX selectors apply the candle ratio per row;
 * SPY/QQQ use native price.
 */
export async function getRecentDarkPoolPrints(opts: {
  date: string;
  symbol: DarkPoolSymbol;
  fromIso: string;
  toIso: string;
  limit?: number;
}): Promise<RecentDarkPoolPrint[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) {
    throw new Error(`Invalid date for getRecentDarkPoolPrints: ${opts.date}`);
  }
  const sql = getDb();
  const config = SELECTOR_CONFIGS[opts.symbol];
  const limit = opts.limit ?? 20;
  const { etfTicker, indexSymbol } = config;

  if (indexSymbol !== null) {
    const rows = (await sql`
      SELECT
        p.executed_at,
        ROUND(p.price * (i.close / e.close))::int AS price,
        p.premium
      FROM dark_pool_prints p
      JOIN etf_candles_1m e
        ON e.ticker = ${etfTicker}
        AND e.timestamp = date_trunc('minute', p.executed_at)
      JOIN index_candles_1m i
        ON i.symbol = ${indexSymbol}
        AND i.timestamp = date_trunc('minute', p.executed_at)
      WHERE p.symbol = ${etfTicker}
        AND p.date = ${opts.date}
        AND p.executed_at >= ${opts.fromIso}
        AND p.executed_at <= ${opts.toIso}
        AND e.close > 0
        AND i.close > 0
      ORDER BY p.executed_at DESC
      LIMIT ${limit}
    `) as Array<{
      executed_at: RequiredTimestampish;
      price: RawNumeric;
      premium: RawNumeric;
    }>;
    return rows.map((r) => ({
      ts: isoOrStringNonNull(r.executed_at),
      price: Number(r.price),
      premium: Number(r.premium),
    }));
  }
  const rows = (await sql`
    SELECT p.executed_at, ROUND(p.price)::int AS price, p.premium
    FROM dark_pool_prints p
    WHERE p.symbol = ${etfTicker}
      AND p.date = ${opts.date}
      AND p.executed_at >= ${opts.fromIso}
      AND p.executed_at <= ${opts.toIso}
    ORDER BY p.executed_at DESC
    LIMIT ${limit}
  `) as Array<{
    executed_at: RequiredTimestampish;
    price: RawNumeric;
    premium: RawNumeric;
  }>;
  return rows.map((r) => ({
    ts: isoOrStringNonNull(r.executed_at),
    price: Number(r.price),
    premium: Number(r.premium),
  }));
}

export interface DarkPoolBucket {
  /** Bucket index from 0 (most recent) to N (older), per `bucketMs`. */
  bucketIndex: number;
  /** Distinct strike count in this bucket. */
  strikeCount: number;
}

/**
 * Time-bucketed distinct strike counts over a [fromIso, nowIso] window.
 * Used by uw-deltas to compute dark-pool print velocity (current bucket
 * vs lookback baseline). Bucket index 0 is the window starting at
 * nowIso looking back bucketMs; bucket 1 is the bucket before that;
 * etc. SPX/NDX use the index-mapped level via candle ratio; SPY/QQQ
 * use native price level.
 */
export async function getDarkPoolStrikeCountBuckets(opts: {
  symbol: DarkPoolSymbol;
  fromIso: string;
  nowIso: string;
  bucketMs: number;
}): Promise<DarkPoolBucket[]> {
  const sql = getDb();
  const config = SELECTOR_CONFIGS[opts.symbol];
  const { etfTicker, indexSymbol } = config;

  if (indexSymbol !== null) {
    const rows = (await sql`
      WITH agg AS (
        SELECT
          FLOOR(EXTRACT(EPOCH FROM (${opts.nowIso}::timestamptz - p.executed_at)) * 1000 / ${opts.bucketMs})::int AS bucket_index,
          ROUND(p.price * (i.close / e.close))::int AS level
        FROM dark_pool_prints p
        JOIN etf_candles_1m e
          ON e.ticker = ${etfTicker}
          AND e.timestamp = date_trunc('minute', p.executed_at)
        JOIN index_candles_1m i
          ON i.symbol = ${indexSymbol}
          AND i.timestamp = date_trunc('minute', p.executed_at)
        WHERE p.symbol = ${etfTicker}
          AND p.executed_at > ${opts.fromIso}
          AND p.executed_at <= ${opts.nowIso}
          AND e.close > 0
          AND i.close > 0
      )
      SELECT bucket_index, COUNT(DISTINCT level) AS strike_count
      FROM agg
      GROUP BY 1
    `) as Array<{ bucket_index: RawNumeric; strike_count: RawNumeric }>;
    return rows.map((r) => ({
      bucketIndex: Number(r.bucket_index),
      strikeCount: Number(r.strike_count),
    }));
  }
  const rows = (await sql`
    WITH agg AS (
      SELECT
        FLOOR(EXTRACT(EPOCH FROM (${opts.nowIso}::timestamptz - p.executed_at)) * 1000 / ${opts.bucketMs})::int AS bucket_index,
        ROUND(p.price)::int AS level
      FROM dark_pool_prints p
      WHERE p.symbol = ${etfTicker}
        AND p.executed_at > ${opts.fromIso}
        AND p.executed_at <= ${opts.nowIso}
    )
    SELECT bucket_index, COUNT(DISTINCT level) AS strike_count
    FROM agg
    GROUP BY 1
  `) as Array<{ bucket_index: RawNumeric; strike_count: RawNumeric }>;
  return rows.map((r) => ({
    bucketIndex: Number(r.bucket_index),
    strikeCount: Number(r.strike_count),
  }));
}
