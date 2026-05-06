/**
 * Query helpers for the `ws_flow_alerts` table (UW WebSocket daemon's
 * burst-alert firehose, migration #108) and its enriched view
 * `ws_flow_alerts_enriched`.
 *
 * Two consumers in this module:
 *
 *   1. fetchRecentFlowAlerts — returns recent alerts on a ticker within
 *      a time + spot-proximity window. Used by the periscope chat
 *      "intraday" / "pre_trade" read context block.
 *
 *   2. aggregateFlowAlertsForDay — returns hourly buckets of bullish vs.
 *      bearish enriched alerts for a full session day. Used by the
 *      "debrief" mode context block. Reads the enriched view because
 *      the call/put + side classification is computed there.
 *
 * Index notes:
 *
 *   - `ws_flow_alerts_ticker_created_idx (ticker, created_at DESC)` is
 *     the covering index for both query shapes here. Daemon writes a
 *     few hundred alerts/min global firehose; ticker-scoped + recent
 *     window keeps the scan tiny.
 *
 *   - `ws_flow_alerts_chain_created_idx (option_chain, created_at)` is
 *     covering for per-contract lookups but NOT what we want here —
 *     periscope context wants "all SPXW alerts in the window," which
 *     spans many distinct option_chain values.
 *
 * All queries use parameterized tagged-template SQL via the Neon
 * driver (`getDb()` returns the tagged template fn). No string
 * concatenation into SQL.
 */

import { getDb } from './db.js';
import logger from './logger.js';

// ── Types ────────────────────────────────────────────────────

/**
 * One row of `ws_flow_alerts` shaped for downstream prose framing in
 * the periscope chat context block. Numeric fields are coerced to
 * `number` (the Neon driver returns `NUMERIC` columns as strings).
 *
 * `total_premium`, `ask_side_ratio`, and `volume` are surfaced because
 * the periscope read prose uses them to differentiate *informed* flow
 * (large premium, lopsided side ratio) from background noise.
 */
export interface FlowAlertRow {
  id: number;
  ticker: string;
  option_chain: string;
  rule_name: string | null;
  option_type: 'C' | 'P';
  strike: number;
  expiry: string;
  created_at: string;
  underlying_price: number | null;
  total_premium: number | null;
  /** Fraction of total premium on the ask side, 0..1; null if no premium. */
  ask_side_ratio: number | null;
  volume: number | null;
}

/**
 * One hourly bucket from {@link aggregateFlowAlertsForDay}. The bucket
 * key is the trading-hour-of-day in CT (e.g. `8` for 08:00–08:59 CT).
 *
 * Bullish vs. bearish is read off `ws_flow_alerts_enriched` — a call
 * with ask-heavy side ratio is bullish, a put with ask-heavy side
 * ratio is bearish, and the inverse for bid-heavy. Ambiguous rows are
 * counted in `neutral`.
 */
export interface DayBucket {
  hourCt: number;
  total: number;
  bullish: number;
  bearish: number;
  neutral: number;
  totalPremium: number;
}

// ── Recent-window query (read / pre_trade modes) ──────────────

interface RecentFlowAlertArgs {
  ticker: 'SPXW' | 'SPX';
  /** How far back to look from {@link asOf}. */
  windowMinutes: number;
  /** Spot proximity: |strike - spot| <= spotProximityPts. */
  spotProximityPts: number;
  /** Anchor SPX spot for the proximity filter. */
  spot: number;
  /** Anchor timestamp for the recency window (read_time or capture time). */
  asOf: Date;
  /** Maximum rows to return; ordered by created_at DESC. */
  topN: number;
}

/**
 * Fetch the most recent flow alerts on `ticker` placed within
 * `windowMinutes` of `asOf` whose strike is within
 * `spotProximityPts` of `spot`. Empty array on DB error
 * (best-effort, the read should not fail because of a context query).
 */
export async function fetchRecentFlowAlerts(
  args: RecentFlowAlertArgs,
): Promise<FlowAlertRow[]> {
  const { ticker, windowMinutes, spotProximityPts, spot, asOf, topN } = args;
  const windowStart = new Date(asOf.getTime() - windowMinutes * 60_000);
  const strikeLo = spot - spotProximityPts;
  const strikeHi = spot + spotProximityPts;

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT
        id,
        ticker,
        option_chain,
        rule_name,
        option_type,
        strike,
        expiry,
        created_at,
        underlying_price,
        total_premium,
        CASE
          WHEN total_premium IS NULL OR total_premium = 0 THEN NULL
          ELSE total_ask_side_prem / total_premium
        END AS ask_side_ratio,
        volume
      FROM ws_flow_alerts
      WHERE ticker = ${ticker}
        AND created_at >= ${windowStart.toISOString()}
        AND created_at <= ${asOf.toISOString()}
        AND strike BETWEEN ${strikeLo} AND ${strikeHi}
      ORDER BY created_at DESC
      LIMIT ${topN}
    `;
    return rows.map((r) => ({
      id: Number(r.id),
      ticker: String(r.ticker),
      option_chain: String(r.option_chain),
      rule_name: r.rule_name == null ? null : String(r.rule_name),
      option_type: r.option_type as 'C' | 'P',
      strike: Number(r.strike),
      expiry: String(r.expiry),
      created_at: String(r.created_at),
      underlying_price:
        r.underlying_price == null ? null : Number(r.underlying_price),
      total_premium: r.total_premium == null ? null : Number(r.total_premium),
      ask_side_ratio:
        r.ask_side_ratio == null ? null : Number(r.ask_side_ratio),
      volume: r.volume == null ? null : Number(r.volume),
    }));
  } catch (err) {
    logger.error({ err, ticker }, 'fetchRecentFlowAlerts failed');
    return [];
  }
}

// ── Day-aggregation query (debrief mode) ─────────────────────

interface AggregateFlowAlertsArgs {
  ticker: 'SPXW' | 'SPX';
  /** ISO YYYY-MM-DD trading day, interpreted in America/Chicago. */
  date: string;
}

/**
 * Aggregate full-day alerts on `ticker` into hourly CT buckets,
 * splitting bullish / bearish / neutral via ws_flow_alerts_enriched
 * (which already computes `ask_side_ratio` and exposes option_type).
 *
 * Bullish/bearish heuristic:
 *   - bullish = (call AND ask_side_ratio >= 0.6) OR (put AND ask_side_ratio <= 0.4)
 *   - bearish = (put  AND ask_side_ratio >= 0.6) OR (call AND ask_side_ratio <= 0.4)
 *   - neutral = everything else (mid-side dominated, or ratio null)
 *
 * The 0.6/0.4 cutoffs match the convention used elsewhere in the
 * codebase for "lopsided" flow. Returns empty array on DB error.
 */
export async function aggregateFlowAlertsForDay(
  args: AggregateFlowAlertsArgs,
): Promise<DayBucket[]> {
  const { ticker, date } = args;

  try {
    const sql = getDb();
    const rows = await sql`
      WITH session AS (
        SELECT
          (created_at AT TIME ZONE 'America/Chicago')::date AS day_ct,
          EXTRACT(
            HOUR FROM (created_at AT TIME ZONE 'America/Chicago')
          )::int AS hour_ct,
          option_type,
          ask_side_ratio,
          total_premium
        FROM ws_flow_alerts_enriched
        WHERE ticker = ${ticker}
          AND (created_at AT TIME ZONE 'America/Chicago')::date = ${date}::date
      )
      SELECT
        hour_ct,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (
          WHERE (option_type = 'C' AND ask_side_ratio >= 0.6)
             OR (option_type = 'P' AND ask_side_ratio <= 0.4)
        )::int AS bullish,
        COUNT(*) FILTER (
          WHERE (option_type = 'P' AND ask_side_ratio >= 0.6)
             OR (option_type = 'C' AND ask_side_ratio <= 0.4)
        )::int AS bearish,
        COUNT(*) FILTER (
          WHERE ask_side_ratio IS NULL
             OR (ask_side_ratio > 0.4 AND ask_side_ratio < 0.6)
        )::int AS neutral,
        COALESCE(SUM(total_premium), 0)::numeric AS total_premium
      FROM session
      GROUP BY hour_ct
      ORDER BY hour_ct ASC
    `;
    return rows.map((r) => ({
      hourCt: Number(r.hour_ct),
      total: Number(r.total),
      bullish: Number(r.bullish),
      bearish: Number(r.bearish),
      neutral: Number(r.neutral),
      totalPremium: Number(r.total_premium),
    }));
  } catch (err) {
    logger.error({ err, ticker, date }, 'aggregateFlowAlertsForDay failed');
    return [];
  }
}
