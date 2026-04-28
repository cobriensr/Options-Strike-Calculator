/**
 * GET /api/options-flow/otm-heavy
 *
 * Rolling-window view of far-OTM SPXW flow where premium is dominated
 * by ask-lifts (bullish load on calls / bearish hedge on puts) or
 * bid-hits (unwinds). Reads the `flow_alerts` table — the ingest cron
 * keeps it fresh every minute, so both live and historical modes use
 * the same query path.
 *
 * Modes:
 *   1. Live (no `date`): window = [now - window_minutes, now]
 *   2. Historical (`date` only): window anchored to 15:00 CT on `date`
 *   3. Scrub (`date` + `as_of`): window = [as_of - window_minutes, as_of]
 *
 * Returns each alert as its own row (no aggregation). Heavy-side
 * filtering is pushed down to SQL using a pair-of-OR-CASEs trick so
 * the `sides` query param can flip between ask-only / bid-only / both
 * without dynamic SQL string building.
 *
 * Query params (see api/_lib/validation.ts → otmHeavyQuerySchema):
 *   ?window_minutes=30    enum [5,15,30,60], default 30
 *   ?min_ask_ratio=0.60   0.5–0.95, default 0.60
 *   ?min_bid_ratio=0.60   0.5–0.95, default 0.60
 *   ?min_distance_pct=0.005  0.001–0.02 (abs value of distance_pct)
 *   ?min_premium=50000    int ≥ 10000, default 50000
 *   ?sides=both           ask | bid | both, default both
 *   ?type=both            call | put | both, default both
 *   ?date=YYYY-MM-DD      optional — triggers historical mode
 *   ?as_of=ISO-8601       optional — scrub ceiling (requires date)
 *   ?limit=100            1–200, default 100
 *
 * Response 200:
 *   {
 *     alerts:        OtmFlowAlert[]   // newest first
 *     alert_count:   number
 *     last_updated:  string | null    // max(created_at) ISO, or null
 *     spot:          number | null    // underlying_price from newest
 *     window_minutes: number          // echo
 *     mode:          'live' | 'historical'
 *     thresholds:    { ask, bid, distance_pct, premium }
 *   }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { checkBot } from '../_lib/api-helpers.js';
import { rejectIfNotOwnerOrGuest } from '../_lib/guest-auth.js';
import { getDb } from '../_lib/db.js';
import { getCtParts } from '../_lib/flow-alert-derive.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';
import { otmHeavyQuerySchema } from '../_lib/validation.js';

// ============================================================
// RESPONSE SHAPE
// ============================================================

export interface OtmFlowAlert {
  id: number;
  option_chain: string;
  strike: number;
  type: 'call' | 'put';
  created_at: string;
  price: number;
  underlying_price: number;
  total_premium: number;
  total_size: number;
  volume: number;
  open_interest: number;
  volume_oi_ratio: number;
  ask_side_ratio: number | null;
  bid_side_ratio: number | null;
  distance_from_spot: number;
  distance_pct: number;
  moneyness: number | null;
  dte_at_alert: number;
  has_sweep: boolean;
  has_multileg: boolean;
  alert_rule: string;
  dominant_side: 'ask' | 'bid';
}

// ============================================================
// SESSION-CLOSE HELPER
// ============================================================

/**
 * Return the UTC ISO timestamp of 15:00 America/Chicago on `dateStr`.
 * Handles DST via candidate-hour + Intl round-trip (same strategy as
 * whale-positioning's session-open helper). 15:00 CT = 20:00 UTC during
 * CDT, 21:00 UTC during CST. Used as the default reference time in
 * historical mode when `as_of` is not provided — anchors the rolling
 * window to market close on the picked date.
 */
function marketCloseUtcForDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map((p) => Number.parseInt(p, 10));
  for (const utcHour of [20, 21]) {
    const candidate = new Date(
      Date.UTC(y!, (m ?? 1) - 1, d ?? 1, utcHour, 0, 0, 0),
    );
    const parts = getCtParts(candidate.toISOString());
    if (parts.hour === 15 && parts.minute === 0) {
      return candidate.toISOString();
    }
  }
  // DST-edge fallback: CDT value. Off by 1h at worst.
  return new Date(
    Date.UTC(y!, (m ?? 1) - 1, d ?? 1, 20, 0, 0, 0),
  ).toISOString();
}

// ============================================================
// DB ROW → OtmFlowAlert TRANSFORM
// ============================================================

/** Raw row shape from the flow_alerts table (NUMERIC cols come back as strings). */
interface OtmFlowAlertRow {
  id: string | number;
  option_chain: string;
  strike: string;
  type: string;
  created_at: string;
  price: string | null;
  underlying_price: string | null;
  total_premium: string;
  total_size: number | null;
  volume: number | null;
  open_interest: number | null;
  volume_oi_ratio: string | null;
  ask_side_ratio: string | null;
  bid_side_ratio: string | null;
  distance_pct: string | null;
  moneyness: string | null;
  dte_at_alert: number | null;
  has_sweep: boolean | null;
  has_multileg: boolean | null;
  alert_rule: string;
}

function parsedOrNull(raw: string | null): number | null {
  if (raw == null) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function dbRowToAlert(row: OtmFlowAlertRow): OtmFlowAlert | null {
  if (row.type !== 'call' && row.type !== 'put') return null;

  const strike = Number.parseFloat(row.strike);
  const spot = parsedOrNull(row.underlying_price);
  const totalPrem = Number.parseFloat(row.total_premium);
  const askRatio = parsedOrNull(row.ask_side_ratio);
  const bidRatio = parsedOrNull(row.bid_side_ratio);

  if (!Number.isFinite(strike) || spot == null || spot <= 0) return null;
  if (!Number.isFinite(totalPrem)) return null;

  // Determine dominant side: whichever ratio is larger. In the SQL filter
  // we've already ensured at least one side clears the user's threshold.
  const dominant_side: 'ask' | 'bid' =
    (askRatio ?? 0) >= (bidRatio ?? 0) ? 'ask' : 'bid';

  const distance_pct = parsedOrNull(row.distance_pct) ?? (strike - spot) / spot;
  const distance_from_spot = strike - spot;

  return {
    id: typeof row.id === 'string' ? Number.parseInt(row.id, 10) : row.id,
    option_chain: row.option_chain,
    strike,
    type: row.type,
    created_at: row.created_at,
    price: parsedOrNull(row.price) ?? 0,
    underlying_price: spot,
    total_premium: totalPrem,
    total_size: row.total_size ?? 0,
    volume: row.volume ?? 0,
    open_interest: row.open_interest ?? 0,
    volume_oi_ratio: parsedOrNull(row.volume_oi_ratio) ?? 0,
    ask_side_ratio: askRatio,
    bid_side_ratio: bidRatio,
    distance_from_spot,
    distance_pct,
    moneyness: parsedOrNull(row.moneyness),
    dte_at_alert: row.dte_at_alert ?? 0,
    has_sweep: row.has_sweep ?? false,
    has_multileg: row.has_multileg ?? false,
    alert_rule: row.alert_rule,
    dominant_side,
  };
}

// ============================================================
// HANDLER
// ============================================================

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/options-flow/otm-heavy');

    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'GET only' });
    }

    const botCheck = await checkBot(req);
    if (botCheck.isBot) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (rejectIfNotOwnerOrGuest(req, res)) return;

    const parsed = otmHeavyQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid query',
        details: parsed.error.flatten(),
      });
    }

    const {
      window_minutes,
      min_ask_ratio,
      min_bid_ratio,
      min_distance_pct,
      min_premium,
      sides,
      type,
      date,
      as_of,
      limit,
    } = parsed.data;

    const mode: 'live' | 'historical' = date ? 'historical' : 'live';

    // Anchor the window: historical uses as_of (or 15:00 CT on the date);
    // live uses now.
    const refTime = date
      ? new Date(as_of ?? marketCloseUtcForDate(date))
      : new Date();
    const windowEnd = refTime;
    const windowStart = new Date(refTime.getTime() - window_minutes * 60_000);

    const sql = getDb();

    try {
      // Heavy-side filter uses a pair-of-OR-CASEs so the `sides` param can
      // flip between ask-only / bid-only / both without building SQL as a
      // string. When `sides='ask'`, the bid branch evaluates to FALSE and
      // vice-versa. Same trick for the type filter.
      const rows = (await sql`
        SELECT
          id,
          option_chain,
          strike::TEXT AS strike,
          type,
          created_at::TEXT AS created_at,
          price::TEXT AS price,
          underlying_price::TEXT AS underlying_price,
          total_premium::TEXT AS total_premium,
          total_size,
          volume,
          open_interest,
          volume_oi_ratio::TEXT AS volume_oi_ratio,
          ask_side_ratio::TEXT AS ask_side_ratio,
          bid_side_ratio::TEXT AS bid_side_ratio,
          distance_pct::TEXT AS distance_pct,
          moneyness::TEXT AS moneyness,
          dte_at_alert,
          has_sweep,
          has_multileg,
          alert_rule
        FROM flow_alerts
        WHERE ticker = 'SPXW'
          AND created_at >= ${windowStart.toISOString()}
          AND created_at <= ${windowEnd.toISOString()}
          AND is_itm = FALSE
          AND ABS(distance_pct) >= ${min_distance_pct}
          AND total_premium >= ${min_premium}
          AND (
            (${sides} IN ('ask', 'both') AND ask_side_ratio >= ${min_ask_ratio})
            OR
            (${sides} IN ('bid', 'both') AND bid_side_ratio >= ${min_bid_ratio})
          )
          AND (${type} = 'both' OR type = ${type})
        ORDER BY created_at DESC
        LIMIT ${limit}
      `) as unknown as OtmFlowAlertRow[];

      const alerts: OtmFlowAlert[] = [];
      for (const row of rows) {
        const a = dbRowToAlert(row);
        if (a !== null) alerts.push(a);
      }

      // Find newest defensively — SQL ORDER BY is DESC, but computing the max
      // here decouples response metadata from SQL ordering if that ever changes.
      const newest = alerts.reduce<OtmFlowAlert | null>(
        (acc, a) => (acc == null || a.created_at > acc.created_at ? a : acc),
        null,
      );

      res.setHeader(
        'Cache-Control',
        mode === 'live'
          ? 'max-age=30, stale-while-revalidate=30'
          : 'max-age=3600, stale-while-revalidate=86400',
      );

      return res.status(200).json({
        alerts,
        alert_count: alerts.length,
        last_updated: newest ? newest.created_at : null,
        spot: newest ? newest.underlying_price : null,
        window_minutes,
        mode,
        thresholds: {
          ask: min_ask_ratio,
          bid: min_bid_ratio,
          distance_pct: min_distance_pct,
          premium: min_premium,
        },
      });
    } catch (err) {
      Sentry.captureException(err);
      logger.error({ err, mode, date, as_of }, 'otm-heavy query error');
      return res.status(500).json({ error: 'OTM flow query failed' });
    }
  });
}
