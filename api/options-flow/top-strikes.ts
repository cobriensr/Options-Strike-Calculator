/**
 * GET /api/options-flow/top-strikes
 *
 * Returns the top-N aggregated + scored 0-1 DTE SPXW strikes from the
 * `flow_alerts` table over a recent window, along with a directional
 * rollup (bullish/bearish lean).
 *
 * Query params:
 *   ?limit=1-20                (default 10)
 *   ?window_minutes=5|15|30|60 (default 15)
 *   ?date=YYYY-MM-DD           (optional, historical date mode)
 *   ?as_of=ISO-timestamp       (optional, scrub mode — requires date)
 *
 * Modes:
 *   1. Live mode (no date, no as_of) — rolling window_minutes cutoff.
 *   2. Date mode (date, no as_of) — full session for that ET date.
 *   3. Scrub mode (date + as_of) — session up to as_of timestamp.
 *
 * Response:
 *   {
 *     strikes:        RankedStrike[]
 *     rollup:         DirectionalRollup
 *     spot:           number | null    // most recent underlying_price
 *     window_minutes: number           // echo of query param
 *     last_updated:   string | null    // newest created_at in window
 *     alert_count:    number           // raw rows in window
 *     timestamps:     string[]         // distinct 1-min bucket timestamps (ASC)
 *   }
 *
 * Polled by the frontend every 60s during market hours (Phase 3).
 */

import { z } from 'zod';
import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/api-helpers.js';
import { withRequestScope } from '../_lib/request-scope.js';
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const querySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(20).default(10),
    window_minutes: z.coerce
      .number()
      .int()
      .refine((v) => v === 5 || v === 15 || v === 30 || v === 60, {
        message: 'window_minutes must be one of: 5, 15, 30, 60',
      })
      .default(15),
    date: z.string().regex(DATE_RE, 'date must be YYYY-MM-DD').optional(),
    as_of: z.string().datetime({ offset: true }).optional(),
  })
  .refine((v) => !(v.as_of && !v.date), {
    message: 'as_of requires date',
    path: ['as_of'],
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
// ET SESSION BOUNDARY HELPERS
// ============================================================

/**
 * Return the UTC offset (in hours) for America/New_York on a given date.
 * EDT (DST) = -4, EST = -5.
 */
function etOffsetHours(dateStr: string): number {
  // Build a Date at noon on the target date — safe from edge cases.
  const d = new Date(`${dateStr}T12:00:00Z`);
  // Intl gives the ET representation; compare to derive the offset.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(d);
  const etHour = Number.parseInt(
    parts.find((p) => p.type === 'hour')?.value ?? '12',
    10,
  );
  // d is noon UTC → etHour = 12 + offset. offset = etHour - 12.
  return etHour - 12;
}

/**
 * Compute session boundaries for a given ET date.
 * Session open = 08:30 ET, end = next day 08:30 ET (captures full session).
 * Returns ISO strings in UTC.
 */
function sessionBounds(dateStr: string): { start: string; end: string } {
  const offset = etOffsetHours(dateStr);
  // 08:30 ET in UTC = 08:30 - offset (offset is negative, so subtract)
  const startUtcH = 8 - offset; // e.g. EDT -4 → 12, EST -5 → 13
  const start = `${dateStr}T${String(startUtcH).padStart(2, '0')}:30:00.000Z`;

  // End: next day same time
  const nextDay = new Date(`${dateStr}T12:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const nextStr = nextDay.toISOString().slice(0, 10);
  const nextOffset = etOffsetHours(nextStr);
  const endUtcH = 8 - nextOffset;
  const end = `${nextStr}T${String(endUtcH).padStart(2, '0')}:30:00.000Z`;

  return { start, end };
}

// ============================================================
// HANDLER
// ============================================================

export default withRequestScope(
  'GET',
  '/api/options-flow/top-strikes',
  async (req, res, done) => {
    if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      done({ status: 400 });
      return res.status(400).json({
        error: 'Invalid query',
        details: parsed.error.flatten(),
      });
    }

    const { limit, window_minutes, date, as_of } = parsed.data;

    try {
      const sql = getDb();

      // ---- Build WHERE boundaries based on mode ----
      let rangeStart: string;
      let rangeEnd: string;

      if (date) {
        // Date mode or Scrub mode
        const bounds = sessionBounds(date);
        rangeStart = bounds.start;
        rangeEnd = as_of ?? bounds.end;
      } else {
        // Live mode — rolling window
        rangeEnd = new Date().toISOString();
        rangeStart = new Date(
          Date.now() - window_minutes * 60_000,
        ).toISOString();
      }

      const rows = (await sql`
        SELECT strike, type, expiry, option_chain, created_at, price,
               underlying_price, total_premium, total_ask_side_prem,
               total_bid_side_prem, total_size, volume, open_interest,
               volume_oi_ratio, has_sweep, has_floor, has_multileg,
               has_singleleg, all_opening_trades, ask_side_ratio,
               net_premium, distance_from_spot, distance_pct, is_itm,
               minute_of_day, alert_rule, ticker
        FROM flow_alerts
        WHERE created_at >= ${rangeStart}
          AND created_at <= ${rangeEnd}
        ORDER BY created_at DESC
      `) as DbRow[];

      // ---- Timestamps: distinct 1-min buckets (ASC) ----
      const tsRows = (await sql`
        SELECT DISTINCT date_trunc('minute', created_at) AS ts
        FROM flow_alerts
        WHERE created_at >= ${rangeStart}
          AND created_at <= ${rangeEnd}
        ORDER BY ts ASC
      `) as Array<{ ts: string | Date }>;

      const timestamps = tsRows.map((r) =>
        r.ts instanceof Date ? r.ts.toISOString() : r.ts,
      );

      res.setHeader('Cache-Control', 'no-store');

      if (rows.length === 0) {
        done({ status: 200 });
        return res.status(200).json({
          strikes: [],
          rollup: EMPTY_ROLLUP,
          spot: null,
          window_minutes,
          last_updated: null,
          alert_count: 0,
          timestamps,
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
      // Note: rollup reflects only the top-N scored strikes (not the full window).
      // By design — the "lean" should reflect what's strongest, not every minor cluster.
      const rollup = computeDirectionalRollup(strikes, spot);

      done({ status: 200 });
      return res.status(200).json({
        strikes,
        rollup,
        spot,
        window_minutes,
        last_updated: lastUpdated,
        alert_count: rows.length,
        timestamps,
      });
    } catch (err) {
      done({ status: 500 });
      Sentry.captureException(err);
      logger.error({ err }, 'top-strikes query error');
      return res.status(500).json({ error: 'Internal error' });
    }
  },
);
