/**
 * GET /api/options-flow/top-strikes
 *
 * Returns the top-N aggregated + scored 0-1 DTE SPXW strikes from the
 * `flow_alerts` table over a recent window, along with a directional
 * rollup (bullish/bearish lean).
 *
 * Query params:
 *   ?limit=1-20              (default 10)
 *   ?window_minutes=5|15|30|60 (default 15)
 *
 * Response:
 *   {
 *     strikes:        RankedStrike[]
 *     rollup:         DirectionalRollup
 *     spot:           number | null    // most recent underlying_price
 *     window_minutes: number           // echo of query param
 *     last_updated:   string | null    // newest created_at in window
 *     alert_count:    number           // raw rows in window
 *   }
 *
 * Polled by the frontend every 60s during market hours (Phase 3).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import { checkBot } from '../_lib/api-helpers.js';
import logger from '../_lib/logger.js';
import {
  rankStrikes,
  computeDirectionalRollup,
  type FlowAlertRow,
  type DirectionalRollup,
} from '../_lib/flow-scoring.js';

// ============================================================
// QUERY VALIDATION
// ============================================================

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(10),
  window_minutes: z.coerce
    .number()
    .int()
    .refine((v) => v === 5 || v === 15 || v === 30 || v === 60, {
      message: 'window_minutes must be one of: 5, 15, 30, 60',
    })
    .default(15),
});

// ============================================================
// DB ROW SHAPE
// ============================================================

/** NUMERIC columns come back as strings from @neondatabase/serverless. */
type Numeric = string | number;
type NumericOrNull = Numeric | null;

/**
 * Shape of a row as returned by Neon's serverless driver for a
 * SELECT against `flow_alerts`.
 */
interface DbRow {
  strike: Numeric;
  type: string;
  expiry: string;
  option_chain: string;
  created_at: string;
  price: NumericOrNull;
  underlying_price: NumericOrNull;
  total_premium: Numeric;
  total_ask_side_prem: NumericOrNull;
  total_bid_side_prem: NumericOrNull;
  total_size: number | null;
  volume: number | null;
  open_interest: number | null;
  volume_oi_ratio: NumericOrNull;
  has_sweep: boolean | null;
  has_floor: boolean | null;
  has_multileg: boolean | null;
  has_singleleg: boolean | null;
  all_opening_trades: boolean | null;
  ask_side_ratio: NumericOrNull;
  net_premium: NumericOrNull;
  distance_from_spot: NumericOrNull;
  distance_pct: NumericOrNull;
  is_itm: boolean | null;
  minute_of_day: number | null;
  alert_rule: string;
  ticker: string;
}

// ============================================================
// HELPERS
// ============================================================

/** Parse a possibly-string NUMERIC into a number, or null. */
function numOrNull(v: NumericOrNull | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const parsed = Number.parseFloat(v);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parse a required NUMERIC (total_premium). Falls back to 0 on garbage. */
function numOrZero(v: NumericOrNull | undefined): number {
  return numOrNull(v) ?? 0;
}

/**
 * Coerce a raw DB row into a strongly-typed FlowAlertRow. Rejects rows
 * with an unknown `type` or `alert_rule` by returning null — scoring
 * expects narrow string literals.
 */
function toFlowAlertRow(row: DbRow): FlowAlertRow | null {
  const type = row.type;
  if (type !== 'call' && type !== 'put') return null;

  const rule = row.alert_rule;
  if (
    rule !== 'RepeatedHits' &&
    rule !== 'RepeatedHitsAscendingFill' &&
    rule !== 'RepeatedHitsDescendingFill'
  ) {
    return null;
  }

  const strike = numOrNull(row.strike);
  if (strike === null) return null;

  return {
    alert_rule: rule,
    ticker: row.ticker,
    strike,
    expiry: row.expiry,
    type,
    option_chain: row.option_chain,
    created_at: row.created_at,
    price: numOrNull(row.price),
    underlying_price: numOrNull(row.underlying_price),
    total_premium: numOrZero(row.total_premium),
    total_ask_side_prem: numOrNull(row.total_ask_side_prem),
    total_bid_side_prem: numOrNull(row.total_bid_side_prem),
    total_size: row.total_size ?? null,
    volume: row.volume ?? null,
    open_interest: row.open_interest ?? null,
    volume_oi_ratio: numOrNull(row.volume_oi_ratio),
    has_sweep: row.has_sweep,
    has_floor: row.has_floor,
    has_multileg: row.has_multileg,
    has_singleleg: row.has_singleleg,
    all_opening_trades: row.all_opening_trades,
    ask_side_ratio: numOrNull(row.ask_side_ratio),
    net_premium: numOrNull(row.net_premium),
    distance_from_spot: numOrNull(row.distance_from_spot),
    distance_pct: numOrNull(row.distance_pct),
    is_itm: row.is_itm,
    minute_of_day: row.minute_of_day ?? null,
  };
}

const EMPTY_ROLLUP: DirectionalRollup = {
  bullish_count: 0,
  bearish_count: 0,
  bullish_premium: 0,
  bearish_premium: 0,
  lean: 'neutral',
  confidence: 0,
  top_bullish_strike: null,
  top_bearish_strike: null,
};

// ============================================================
// HANDLER
// ============================================================

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/options-flow/top-strikes');

    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'GET only' });
    }

    const botCheck = await checkBot(req);
    if (botCheck.isBot) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid query',
        details: parsed.error.flatten(),
      });
    }

    const { limit, window_minutes } = parsed.data;

    try {
      const sql = getDb();
      const cutoff = new Date(
        Date.now() - window_minutes * 60_000,
      ).toISOString();

      const rows = (await sql`
        SELECT strike, type, expiry, option_chain, created_at, price,
               underlying_price, total_premium, total_ask_side_prem,
               total_bid_side_prem, total_size, volume, open_interest,
               volume_oi_ratio, has_sweep, has_floor, has_multileg,
               has_singleleg, all_opening_trades, ask_side_ratio,
               net_premium, distance_from_spot, distance_pct, is_itm,
               minute_of_day, alert_rule, ticker
        FROM flow_alerts
        WHERE created_at >= ${cutoff}
        ORDER BY created_at DESC
      `) as DbRow[];

      res.setHeader('Cache-Control', 'no-store');

      if (rows.length === 0) {
        return res.status(200).json({
          strikes: [],
          rollup: EMPTY_ROLLUP,
          spot: null,
          window_minutes,
          last_updated: null,
          alert_count: 0,
        });
      }

      // rows[0] is the newest (ORDER BY created_at DESC).
      const spot = numOrNull(rows[0]!.underlying_price);
      const lastUpdated = rows[0]!.created_at;

      const alerts: FlowAlertRow[] = [];
      for (const row of rows) {
        const alert = toFlowAlertRow(row);
        if (alert !== null) alerts.push(alert);
      }

      const strikes = rankStrikes(alerts, limit);
      const rollup = computeDirectionalRollup(strikes, spot);

      return res.status(200).json({
        strikes,
        rollup,
        spot,
        window_minutes,
        last_updated: lastUpdated,
        alert_count: rows.length,
      });
    } catch (err) {
      Sentry.captureException(err);
      logger.error({ err }, 'top-strikes query error');
      return res.status(500).json({
        error: 'DB error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
