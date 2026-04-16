/**
 * GET /api/options-flow/whale-positioning
 *
 * Live-query proxy to Unusual Whales `/option-trades/flow-alerts` that
 * surfaces whale-sized institutional positioning in SPXW. Unlike
 * `/api/options-flow/top-strikes` — which reads the `flow_alerts` table
 * filtered to 0-1 DTE RepeatedHits — this endpoint casts a wider net:
 *
 *   - 0-7 DTE (configurable, capped at 30)
 *   - Premium >= $1M by default (configurable)
 *   - All alert rules (no rule_name filter)
 *   - Live UW proxy (no DB), or historical DB query for backtesting
 *
 * Each returned alert is its own row (no aggregation). Derived fields
 * are computed inline from UW's response (live) or read from pre-
 * computed DB columns (historical).
 *
 * Modes:
 *   1. **Live** (no `date`): Proxy to UW live API. timestamps=[]
 *   2. **Date** (`date` only): Query `whale_alerts` DB table for the
 *      full session on that date.
 *   3. **Scrub** (`date` + `as_of`): Same as date mode, additionally
 *      filter WHERE created_at <= as_of.
 *
 * Query params:
 *   ?min_premium=1000000  (default 1_000_000, min 500_000 — matches the
 *                          whale cron's hardcoded threshold and the UI
 *                          slider floor; prevents a crafted request from
 *                          dumping the full UW flow-alerts feed)
 *   ?max_dte=7            (default 7, 0-30)
 *   ?limit=20             (default 20, 1-50)
 *   ?date=2026-04-15      (optional YYYY-MM-DD — triggers historical mode)
 *   ?as_of=2026-04-15T14:30:00Z  (optional ISO timestamp — scrub ceiling)
 *
 * Response 200:
 *   {
 *     strikes:        WhaleAlert[]
 *     total_premium:  number    // sum over returned (sliced) alerts
 *     alert_count:    number    // strikes.length
 *     last_updated:   string|null   // newest created_at, or null
 *     spot:           number|null   // underlying_price from newest, or null
 *     window_minutes: number    // effective "since session open" minutes
 *     min_premium:    number    // echo
 *     max_dte:        number    // echo
 *     timestamps:     string[] // ascending 1-min bucket ISO timestamps
 *   }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { Sentry } from '../_lib/sentry.js';
import { checkBot, uwFetch } from '../_lib/api-helpers.js';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';
import {
  getCtParts,
  isoDateToEpochDays,
  type UwFlowAlert,
} from '../_lib/flow-alert-derive.js';

// ============================================================
// QUERY VALIDATION
// ============================================================

const querySchema = z.object({
  min_premium: z.coerce.number().int().min(500_000).default(1_000_000),
  max_dte: z.coerce.number().int().min(0).max(30).default(7),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  as_of: z.string().datetime({ offset: true }).optional(),
}).refine((v) => !(v.as_of && !v.date), {
  message: 'as_of requires date',
  path: ['as_of'],
});

// ============================================================
// RESPONSE SHAPE
// ============================================================

interface WhaleAlert {
  option_chain: string;
  strike: number;
  type: 'call' | 'put';
  expiry: string;
  dte_at_alert: number;
  created_at: string;
  age_minutes: number;
  total_premium: number;
  total_ask_side_prem: number;
  total_bid_side_prem: number;
  ask_side_ratio: number | null;
  total_size: number;
  volume: number;
  open_interest: number;
  volume_oi_ratio: number;
  has_sweep: boolean;
  has_floor: boolean;
  has_multileg: boolean;
  alert_rule: string;
  underlying_price: number;
  distance_from_spot: number;
  distance_pct: number;
  is_itm: boolean;
}

// ============================================================
// SESSION-OPEN HELPERS
// ============================================================

/**
 * Return the UTC ISO timestamp of the most recent 08:30 America/Chicago
 * instant at or before `now`. If `now` is before today's 08:30 CT, returns
 * null (pre-market — caller should skip `newer_than`). Uses Intl TZ lookup
 * to avoid DST bugs.
 */
function lastSessionOpenUtc(now: Date): string | null {
  // Candidate UTC hour for 08:30 CT is 13:30 UTC during CDT, 14:30 UTC during
  // CST. Try both; pick the one that lands on 08:30 in CT on the same CT
  // calendar day.
  const nowParts = getCtParts(now.toISOString());
  const [y, m, d] = nowParts.dateStr
    .split('-')
    .map((p) => Number.parseInt(p, 10));

  for (const utcHour of [13, 14]) {
    const candidate = new Date(
      Date.UTC(y!, (m ?? 1) - 1, d ?? 1, utcHour, 30, 0, 0),
    );
    const parts = getCtParts(candidate.toISOString());
    if (
      parts.dateStr === nowParts.dateStr &&
      parts.hour === 8 &&
      parts.minute === 30
    ) {
      if (candidate.getTime() <= now.getTime()) {
        return candidate.toISOString();
      }
      return null; // pre-market today
    }
  }
  return null;
}

/**
 * Return the UTC ISO timestamp of 08:30 America/New_York on a given
 * YYYY-MM-DD date string. Accounts for DST by trying both candidate
 * UTC hours (12:30 for EDT, 13:30 for EST) and verifying the result
 * via Intl TZ lookup — same strategy as `lastSessionOpenUtc` but for
 * ET instead of CT.
 */
function sessionOpenUtcForDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map((p) => Number.parseInt(p, 10));
  // 08:30 EDT = 12:30 UTC, 08:30 EST = 13:30 UTC
  for (const utcHour of [12, 13]) {
    const candidate = new Date(
      Date.UTC(y!, (m ?? 1) - 1, d ?? 1, utcHour, 30, 0, 0),
    );
    const etFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });
    const etParts = etFmt.formatToParts(candidate);
    const getP = (type: string) =>
      etParts.find((p) => p.type === type)?.value ?? '';
    const etHour = Number.parseInt(getP('hour'), 10) % 24;
    const etMin = Number.parseInt(getP('minute'), 10);
    if (etHour === 8 && etMin === 30) {
      return candidate.toISOString();
    }
  }
  // Fallback: assume EDT (12:30 UTC)
  return new Date(
    Date.UTC(y!, (m ?? 1) - 1, d ?? 1, 12, 30, 0, 0),
  ).toISOString();
}

// ============================================================
// DB ROW → WhaleAlert TRANSFORM
// ============================================================

/** DB row type from the whale_alerts table (NUMERIC cols are strings). */
interface WhaleAlertRow {
  option_chain: string;
  strike: string;
  type: string;
  expiry: string;
  dte_at_alert: number | null;
  created_at: string;
  total_premium: string;
  total_ask_side_prem: string | null;
  total_bid_side_prem: string | null;
  total_size: number | null;
  volume: number | null;
  open_interest: number | null;
  volume_oi_ratio: string | null;
  has_sweep: boolean | null;
  has_floor: boolean | null;
  has_multileg: boolean | null;
  alert_rule: string;
  underlying_price: string | null;
  distance_from_spot: string | null;
  distance_pct: string | null;
  is_itm: boolean | null;
}

/** Parse a nullable NUMERIC string; return fallback when null/NaN. */
function parsedOrFallback(raw: string | null, fallback: number): number {
  if (raw == null) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function dbRowToWhaleAlert(
  row: WhaleAlertRow,
  nowMs: number,
): WhaleAlert | null {
  const type = row.type;
  if (type !== 'call' && type !== 'put') return null;

  const strike = Number.parseFloat(row.strike);
  const spot = Number.parseFloat(row.underlying_price ?? '');
  const totalPrem = Number.parseFloat(row.total_premium);
  const askPrem = Number.parseFloat(row.total_ask_side_prem ?? '');
  const bidPrem = Number.parseFloat(row.total_bid_side_prem ?? '');
  const volOiRatio = Number.parseFloat(row.volume_oi_ratio ?? '');

  if (!Number.isFinite(strike) || !Number.isFinite(spot) || spot <= 0) {
    return null;
  }

  const createdMs = new Date(row.created_at).getTime();
  const age_minutes = Number.isFinite(createdMs)
    ? Math.max(0, Math.round((nowMs - createdMs) / 60_000))
    : 0;

  const ask_side_ratio =
    Number.isFinite(totalPrem) && totalPrem > 0 ? askPrem / totalPrem : null;

  return {
    option_chain: row.option_chain,
    strike,
    type,
    expiry: row.expiry,
    dte_at_alert: row.dte_at_alert ?? 0,
    created_at: row.created_at,
    age_minutes,
    total_premium: Number.isFinite(totalPrem) ? totalPrem : 0,
    total_ask_side_prem: Number.isFinite(askPrem) ? askPrem : 0,
    total_bid_side_prem: Number.isFinite(bidPrem) ? bidPrem : 0,
    ask_side_ratio,
    total_size: row.total_size ?? 0,
    volume: row.volume ?? 0,
    open_interest: row.open_interest ?? 0,
    volume_oi_ratio: Number.isFinite(volOiRatio) ? volOiRatio : 0,
    has_sweep: row.has_sweep ?? false,
    has_floor: row.has_floor ?? false,
    has_multileg: row.has_multileg ?? false,
    alert_rule: row.alert_rule,
    underlying_price: spot,
    distance_from_spot: parsedOrFallback(row.distance_from_spot, strike - spot),
    distance_pct: parsedOrFallback(row.distance_pct, (strike - spot) / spot),
    is_itm: row.is_itm ?? (type === 'call' ? strike < spot : strike > spot),
  };
}

// ============================================================
// DERIVED-FIELD TRANSFORM
// ============================================================

function toWhaleAlert(a: UwFlowAlert, nowMs: number): WhaleAlert | null {
  const type = a.type;
  if (type !== 'call' && type !== 'put') return null;

  const strike = Number.parseFloat(a.strike);
  const spot = Number.parseFloat(a.underlying_price);
  const totalPrem = Number.parseFloat(a.total_premium);
  const askPrem = Number.parseFloat(a.total_ask_side_prem);
  const bidPrem = Number.parseFloat(a.total_bid_side_prem);
  const volOiRatio = Number.parseFloat(a.volume_oi_ratio);

  if (!Number.isFinite(strike) || !Number.isFinite(spot) || spot <= 0) {
    return null;
  }

  const { dateStr } = getCtParts(a.created_at);
  const alertEpoch = isoDateToEpochDays(dateStr);
  const expiryEpoch = isoDateToEpochDays(a.expiry);
  const dte_at_alert = Math.max(0, expiryEpoch - alertEpoch);

  const createdMs = new Date(a.created_at).getTime();
  const age_minutes = Number.isFinite(createdMs)
    ? Math.max(0, Math.round((nowMs - createdMs) / 60_000))
    : 0;

  const ask_side_ratio =
    Number.isFinite(totalPrem) && totalPrem > 0 ? askPrem / totalPrem : null;

  const distance_from_spot = strike - spot;
  const distance_pct = (strike - spot) / spot;
  const is_itm = type === 'call' ? strike < spot : strike > spot;

  return {
    option_chain: a.option_chain,
    strike,
    type,
    expiry: a.expiry,
    dte_at_alert,
    created_at: a.created_at,
    age_minutes,
    total_premium: Number.isFinite(totalPrem) ? totalPrem : 0,
    total_ask_side_prem: Number.isFinite(askPrem) ? askPrem : 0,
    total_bid_side_prem: Number.isFinite(bidPrem) ? bidPrem : 0,
    ask_side_ratio,
    total_size: a.total_size,
    volume: a.volume,
    open_interest: a.open_interest,
    volume_oi_ratio: Number.isFinite(volOiRatio) ? volOiRatio : 0,
    has_sweep: a.has_sweep,
    has_floor: a.has_floor,
    has_multileg: a.has_multileg,
    alert_rule: a.alert_rule,
    underlying_price: spot,
    distance_from_spot,
    distance_pct,
    is_itm,
  };
}

// ============================================================
// UW PATH BUILDER
// ============================================================

function buildWhalePath(params: {
  min_premium: number;
  max_dte: number;
  newer_than: string | null;
}): string {
  const qs = new URLSearchParams();
  qs.append('ticker_symbol', 'SPXW');
  qs.append('issue_types[]', 'Index');
  qs.append('min_dte', '0');
  qs.append('max_dte', String(params.max_dte));
  qs.append('min_premium', String(params.min_premium));
  qs.append('limit', '200');
  if (params.newer_than) qs.append('newer_than', params.newer_than);
  return `/option-trades/flow-alerts?${qs.toString()}`;
}

// ============================================================
// HISTORICAL DB QUERY
// ============================================================

/**
 * Query the whale_alerts table for a historical date session.
 * Returns { rows, timestamps } where timestamps are distinct
 * 1-minute bucket ISO strings in ascending order.
 */
async function fetchHistoricalAlerts(opts: {
  date: string;
  as_of?: string;
  min_premium: number;
  max_dte: number;
}): Promise<{ rows: WhaleAlertRow[]; timestamps: string[] }> {
  const sql = getDb();
  const sessionOpen = sessionOpenUtcForDate(opts.date);

  // End of session: next calendar day's session open serves as a
  // generous upper bound (captures post-close ingestion lag).
  const nextDay = new Date(
    new Date(sessionOpen).getTime() + 24 * 60 * 60 * 1000,
  );
  const sessionEnd = sessionOpenUtcForDate(nextDay.toISOString().slice(0, 10));

  // Build the time ceiling: as_of if provided, otherwise session end
  const ceiling = opts.as_of ?? sessionEnd;

  const rows = (await sql`
    SELECT
      option_chain, strike::TEXT AS strike, type,
      expiry::TEXT AS expiry, dte_at_alert,
      created_at::TEXT AS created_at,
      total_premium::TEXT AS total_premium,
      total_ask_side_prem::TEXT AS total_ask_side_prem,
      total_bid_side_prem::TEXT AS total_bid_side_prem,
      total_size, volume, open_interest,
      volume_oi_ratio::TEXT AS volume_oi_ratio,
      has_sweep, has_floor, has_multileg,
      alert_rule,
      underlying_price::TEXT AS underlying_price,
      distance_from_spot::TEXT AS distance_from_spot,
      distance_pct::TEXT AS distance_pct,
      is_itm
    FROM whale_alerts
    WHERE created_at >= ${sessionOpen}
      AND created_at <= ${ceiling}
      AND total_premium >= ${opts.min_premium}
      AND dte_at_alert <= ${opts.max_dte}
    ORDER BY total_premium DESC
  `) as unknown as WhaleAlertRow[];

  const tsRows = (await sql`
    SELECT DISTINCT
      date_trunc('minute', created_at)::TEXT AS ts
    FROM whale_alerts
    WHERE created_at >= ${sessionOpen}
      AND created_at <= ${ceiling}
    ORDER BY ts ASC
  `) as unknown as { ts: string }[];

  const timestamps = tsRows.map((r) => r.ts);

  return { rows, timestamps };
}

// ============================================================
// SHARED RESPONSE BUILDER
// ============================================================

function buildResponse(
  sliced: WhaleAlert[],
  windowMinutes: number,
  min_premium: number,
  max_dte: number,
  timestamps: string[],
) {
  const totalPremium = sliced.reduce((sum, a) => sum + a.total_premium, 0);
  const newest = sliced.reduce<WhaleAlert | null>((acc, a) => {
    if (acc === null) return a;
    return a.created_at > acc.created_at ? a : acc;
  }, null);

  return {
    strikes: sliced,
    total_premium: totalPremium,
    alert_count: sliced.length,
    last_updated: newest ? newest.created_at : null,
    spot: newest ? newest.underlying_price : null,
    window_minutes: windowMinutes,
    min_premium,
    max_dte,
    timestamps,
  };
}

// ============================================================
// HANDLER
// ============================================================

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/options-flow/whale-positioning');

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

    const { min_premium, max_dte, limit, date, as_of } = parsed.data;

    // ── Historical mode (date provided) ──────────────────────
    if (date) {
      try {
        const sessionOpen = sessionOpenUtcForDate(date);
        const refTime = as_of ? new Date(as_of) : new Date();
        const sessionOpenMs = new Date(sessionOpen).getTime();
        const windowMinutes = Math.max(
          0,
          Math.round((refTime.getTime() - sessionOpenMs) / 60_000),
        );

        const { rows, timestamps } = await fetchHistoricalAlerts({
          date,
          as_of,
          min_premium,
          max_dte,
        });

        const nowMs = refTime.getTime();
        const transformed: WhaleAlert[] = [];
        for (const row of rows) {
          const w = dbRowToWhaleAlert(row, nowMs);
          if (w !== null) transformed.push(w);
        }

        // Already sorted by premium DESC from SQL; just slice
        const sliced = transformed.slice(0, limit);

        // Historical data is immutable — cache aggressively
        res.setHeader(
          'Cache-Control',
          'max-age=3600, stale-while-revalidate=86400',
        );

        return res
          .status(200)
          .json(
            buildResponse(
              sliced,
              windowMinutes,
              min_premium,
              max_dte,
              timestamps,
            ),
          );
      } catch (err) {
        Sentry.captureException(err);
        logger.error(
          { err, date, as_of },
          'whale-positioning historical query error',
        );
        return res.status(500).json({ error: 'Historical data query failed' });
      }
    }

    // ── Live mode (no date) ──────────────────────────────────
    const apiKey = process.env.UW_API_KEY ?? '';
    if (!apiKey) {
      logger.error('UW_API_KEY not configured');
      return res.status(500).json({ error: 'Upstream flow data unavailable' });
    }

    const now = new Date();
    const sessionOpenIso = lastSessionOpenUtc(now);
    const windowMinutes = sessionOpenIso
      ? Math.max(
          0,
          Math.round(
            (now.getTime() - new Date(sessionOpenIso).getTime()) / 60_000,
          ),
        )
      : 0;

    try {
      const path = buildWhalePath({
        min_premium,
        max_dte,
        // After-hours (null sessionOpenIso once we rolled past
        // next midnight in CT logic) behavior: spec says "show
        // the full last session's data (don't blank it out
        // outside market hours)". Our lastSessionOpenUtc only
        // returns null when we're PRE-market today — post-close
        // we still have today's 13:30 UTC behind us and get it
        // back. Post-close is therefore handled the same as
        // mid-session.
        newer_than: sessionOpenIso,
      });

      const rawAlerts = await uwFetch<UwFlowAlert>(apiKey, path);

      const nowMs = now.getTime();
      const transformed: WhaleAlert[] = [];
      for (const a of rawAlerts) {
        const w = toWhaleAlert(a, nowMs);
        if (w !== null) transformed.push(w);
      }

      transformed.sort((a, b) => b.total_premium - a.total_premium);
      const sliced = transformed.slice(0, limit);

      res.setHeader('Cache-Control', 'max-age=30, stale-while-revalidate=30');

      return res.status(200).json(
        buildResponse(
          sliced,
          windowMinutes,
          min_premium,
          max_dte,
          [], // live mode: no timestamps
        ),
      );
    } catch (err) {
      Sentry.captureException(err);
      logger.error({ err }, 'whale-positioning UW fetch error');
      return res.status(502).json({ error: 'Upstream flow data unavailable' });
    }
  });
}
