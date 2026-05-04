/**
 * Shared dark-pool query helper.
 *
 * Reads aggregated dark-pool levels from the new `dark_pool_prints`
 * table (raw per-print rows written by the uw-stream daemon's
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
 * Transition fallback (SPX only): the legacy `dark_pool_levels` table
 * (cron-fed, SPY-only, static SPX×10 mapping) is the data source for
 * any date where `dark_pool_prints` has no rows yet. This preserves
 * historical reads while the daemon backfills. The fallback path is
 * removed in Phase 7 (final cutover) when the legacy table is dropped.
 *
 * NDX/SPY/QQQ selectors do NOT fall back — those views did not exist
 * pre-migration, so an empty result for an unbackfilled date is the
 * honest answer.
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
  /** True when the result came from the legacy `dark_pool_levels` table. */
  legacyFallback: boolean;
}

interface SelectorConfig {
  /** The ETF whose prints are stored in dark_pool_prints. */
  etfTicker: 'SPY' | 'QQQ';
  /** The index symbol to look up in index_candles_1m for the ratio.
   *  null = native ETF view (no ratio scaling). */
  indexSymbol: 'SPX' | 'NDX' | null;
  /** True if the legacy dark_pool_levels table can serve as a fallback.
   *  Only SPX qualifies — the legacy table is SPY+SPX-only. */
  legacyFallback: boolean;
}

const SELECTOR_CONFIGS: Record<DarkPoolSymbol, SelectorConfig> = {
  SPX: { etfTicker: 'SPY', indexSymbol: 'SPX', legacyFallback: true },
  NDX: { etfTicker: 'QQQ', indexSymbol: 'NDX', legacyFallback: false },
  SPY: { etfTicker: 'SPY', indexSymbol: null, legacyFallback: false },
  QQQ: { etfTicker: 'QQQ', indexSymbol: null, legacyFallback: false },
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

interface LegacyRow {
  spx_approx: RawNumeric;
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
 * Soak-window fallback control. Until USE_DAEMON_DARK_POOL is set to
 * 'true' in the environment, SPX selectors ALWAYS read from the legacy
 * dark_pool_levels table — even when dark_pool_prints has rows. This
 * prevents the "one daemon print bypasses the entire cron-fed dataset"
 * footgun during the soak window when the daemon is still warming up.
 *
 * NDX/SPY/QQQ selectors ignore this flag — they have no legacy source
 * to fall back to and always read from dark_pool_prints.
 */
function shouldPreferDaemon(): boolean {
  return process.env.USE_DAEMON_DARK_POOL === 'true';
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
  // Defense-in-depth: validate date even though every current caller
  // already does. Future callers (ML pipeline helpers in Phase 4c) may
  // not — and a malformed date would otherwise reach the SQL layer.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) {
    throw new Error(`Invalid date for getDarkPoolLevels: ${opts.date}`);
  }

  const sql = getDb();
  const config = SELECTOR_CONFIGS[opts.symbol];

  // Soak-window guard: SPX prefers legacy until daemon coverage is
  // verified and USE_DAEMON_DARK_POOL=true is set. Multi-symbol
  // selectors (NDX/SPY/QQQ) always go to prints — they have no legacy
  // source to fall back to.
  if (config.legacyFallback && !shouldPreferDaemon()) {
    const legacyRows = await queryLegacy(sql, {
      date: opts.date,
      asOfTimeCT: opts.asOfTimeCT,
    });
    return {
      levels: legacyRows.map(transformLegacyRow),
      lastUpdated:
        legacyRows.length > 0
          ? isoOrString(legacyRows[0]!.max_updated_at)
          : null,
      legacyFallback: true,
    };
  }

  const printsRows = await queryPrints(sql, {
    date: opts.date,
    config,
    asOfTimeCT: opts.asOfTimeCT,
  });

  if (printsRows.length > 0) {
    return {
      levels: printsRows.map(transformPrintsRow),
      lastUpdated: isoOrString(printsRows[0]!.max_updated_at),
      legacyFallback: false,
    };
  }

  // Empty prints: with the daemon flag on, SPX still falls back to the
  // legacy table for dates the daemon hasn't backfilled. NDX/SPY/QQQ
  // honestly return empty — those views did not exist pre-migration.
  if (config.legacyFallback) {
    const legacyRows = await queryLegacy(sql, {
      date: opts.date,
      asOfTimeCT: opts.asOfTimeCT,
    });
    if (legacyRows.length > 0) {
      return {
        levels: legacyRows.map(transformLegacyRow),
        lastUpdated: isoOrString(legacyRows[0]!.max_updated_at),
        legacyFallback: true,
      };
    }
  }

  return { levels: [], lastUpdated: null, legacyFallback: false };
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

async function queryLegacy(
  sql: NeonQueryFunction<false, false>,
  opts: { date: string; asOfTimeCT?: string },
): Promise<LegacyRow[]> {
  if (opts.asOfTimeCT && /^\d{2}:\d{2}$/.test(opts.asOfTimeCT)) {
    return (await sql`
      SELECT spx_approx, total_premium, trade_count, total_shares,
             latest_time, updated_at,
             MAX(updated_at) OVER () AS max_updated_at
      FROM dark_pool_levels
      WHERE date = ${opts.date}
        AND latest_time <= (${`${opts.date} ${opts.asOfTimeCT}:00`}::timestamp AT TIME ZONE 'America/Chicago')
      ORDER BY total_premium DESC
    `) as LegacyRow[];
  }
  return (await sql`
    SELECT spx_approx, total_premium, trade_count, total_shares,
           latest_time, updated_at,
           MAX(updated_at) OVER () AS max_updated_at
    FROM dark_pool_levels
    WHERE date = ${opts.date}
    ORDER BY total_premium DESC
  `) as LegacyRow[];
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

function transformLegacyRow(r: LegacyRow): DarkPoolLevel {
  return {
    level: Number(r.spx_approx),
    totalPremium: Number(r.total_premium),
    tradeCount: Number(r.trade_count),
    totalShares: Number(r.total_shares),
    latestTime: isoOrStringNonNull(r.latest_time),
    updatedAt: isoOrString(r.updated_at),
  };
}
