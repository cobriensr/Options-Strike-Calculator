/**
 * GET /api/interval-ba-feed
 *
 * Historical-backtest feed for the SPXW Interval B/A alerts table.
 * Returns every alert that fired on a given CT calendar date within an
 * optional CT-anchored time window. Distinct from /api/interval-ba-alerts
 * which is tuned for the live polling hook (today + unacknowledged).
 *
 * Owner-or-guest — same provenance as the live endpoint (OPRA data).
 *
 * Query params (all optional except `date`):
 *   ?date=YYYY-MM-DD       — CT calendar date (required)
 *   ?startTime=HH:MM       — CT start (default 08:30 — regular session open)
 *   ?endTime=HH:MM         — CT end   (default 15:00 — regular session close)
 *   ?optionType=C|P        — filter to calls or puts (default both)
 *   ?minPremium=N          — filter to total_premium >= N USD (default 0)
 *
 * Response:
 *   {
 *     alerts:  IntervalBAFeedAlert[],
 *     summary: { count, total_premium, extreme, critical, warning }
 *   }
 *
 * Spec: docs/superpowers/specs/interval-ba-ask-alert-2026-05-12.md.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from './_lib/db.js';
import { Sentry, metrics } from './_lib/sentry.js';
import { guardOwnerOrGuestEndpoint } from './_lib/api-helpers.js';
import logger from './_lib/logger.js';
import { ctWallClockToUtcIso } from '../src/utils/timezone.js';

type Severity = 'extreme' | 'critical' | 'warning';

interface FeedAlert {
  id: number;
  option_chain: string;
  ticker: string;
  option_type: string;
  strike: number;
  expiry: string;
  bucket_start: string;
  bucket_end: string;
  fired_at: string;
  ratio_pct: number;
  ask_premium: number;
  total_premium: number;
  trade_count: number;
  top_trade_premium: number | null;
  top_trade_size: number | null;
  top_trade_executed_at: string | null;
  top_trade_is_sweep: boolean | null;
  top_trade_is_floor: boolean | null;
  underlying_price: number | null;
  severity: Severity;
}

interface FeedSummary {
  count: number;
  total_premium: number;
  extreme: number;
  critical: number;
  warning: number;
}

const DEFAULT_START_TIME = '08:30';
const DEFAULT_END_TIME = '15:00';
// Hard cap to defend against a bad date range pulling thousands of rows
// in one request. Single-day backtest typically returns <200 rows.
const MAX_ROWS = 500;

const EXTREME_THRESHOLD = 1_000_000;
const CRITICAL_THRESHOLD = 500_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function deriveSeverity(totalPremium: number): Severity {
  if (totalPremium >= EXTREME_THRESHOLD) return 'extreme';
  if (totalPremium >= CRITICAL_THRESHOLD) return 'critical';
  return 'warning';
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number.parseFloat(v);
  return 0;
}

function toNumberOrNull(v: unknown): number | null {
  if (v == null) return null;
  return toNumber(v);
}

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  return '';
}

function toIsoOrNull(v: unknown): string | null {
  if (v == null) return null;
  return toIso(v);
}

function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(':').map((s) => Number.parseInt(s, 10));
  return (h ?? 0) * 60 + (m ?? 0);
}

interface RawRow {
  id: number;
  option_chain: string;
  ticker: string;
  option_type: string;
  strike: string | number;
  expiry: string | Date;
  bucket_start: string | Date;
  bucket_end: string | Date;
  fired_at: string | Date;
  ratio_pct: string | number;
  ask_premium: string | number;
  total_premium: string | number;
  trade_count: number;
  top_trade_premium: string | number | null;
  top_trade_size: number | null;
  top_trade_executed_at: string | Date | null;
  top_trade_is_sweep: boolean | null;
  top_trade_is_floor: boolean | null;
  underlying_price: string | number | null;
}

function shapeRow(r: RawRow): FeedAlert {
  const total_premium = toNumber(r.total_premium);
  return {
    id: r.id,
    option_chain: r.option_chain,
    ticker: r.ticker,
    option_type: r.option_type,
    strike: toNumber(r.strike),
    expiry: toIso(r.expiry).slice(0, 10),
    bucket_start: toIso(r.bucket_start),
    bucket_end: toIso(r.bucket_end),
    fired_at: toIso(r.fired_at),
    ratio_pct: toNumber(r.ratio_pct),
    ask_premium: toNumber(r.ask_premium),
    total_premium,
    trade_count: r.trade_count,
    top_trade_premium: toNumberOrNull(r.top_trade_premium),
    top_trade_size: r.top_trade_size,
    top_trade_executed_at: toIsoOrNull(r.top_trade_executed_at),
    top_trade_is_sweep: r.top_trade_is_sweep,
    top_trade_is_floor: r.top_trade_is_floor,
    underlying_price: toNumberOrNull(r.underlying_price),
    severity: deriveSeverity(total_premium),
  };
}

function buildSummary(alerts: FeedAlert[]): FeedSummary {
  let extreme = 0;
  let critical = 0;
  let warning = 0;
  let total_premium = 0;
  for (const a of alerts) {
    total_premium += a.total_premium;
    if (a.severity === 'extreme') extreme += 1;
    else if (a.severity === 'critical') critical += 1;
    else warning += 1;
  }
  return { count: alerts.length, total_premium, extreme, critical, warning };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/interval-ba-feed');
    const done = metrics.request('/api/interval-ba-feed');

    try {
      if (req.method !== 'GET') {
        done({ status: 405 });
        return res.status(405).json({ error: 'GET only' });
      }

      if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

      const dateStr = req.query.date as string | undefined;
      if (!dateStr || !DATE_RE.test(dateStr)) {
        done({ status: 400 });
        return res.status(400).json({
          error: 'date required (YYYY-MM-DD)',
        });
      }
      const startTimeStr =
        (req.query.startTime as string) || DEFAULT_START_TIME;
      const endTimeStr = (req.query.endTime as string) || DEFAULT_END_TIME;
      if (!TIME_RE.test(startTimeStr) || !TIME_RE.test(endTimeStr)) {
        done({ status: 400 });
        return res.status(400).json({
          error: 'startTime / endTime must be HH:MM (24-hour CT)',
        });
      }
      const startMin = parseTimeToMinutes(startTimeStr);
      const endMin = parseTimeToMinutes(endTimeStr);
      if (endMin <= startMin) {
        done({ status: 400 });
        return res.status(400).json({
          error: 'endTime must be after startTime',
        });
      }

      const optionTypeRaw = req.query.optionType as string | undefined;
      const optionType =
        optionTypeRaw === 'C' || optionTypeRaw === 'P' ? optionTypeRaw : null;

      const minPremiumRaw = req.query.minPremium as string | undefined;
      const minPremium =
        minPremiumRaw && Number.isFinite(Number.parseFloat(minPremiumRaw))
          ? Math.max(0, Number.parseFloat(minPremiumRaw))
          : 0;

      const fromUtc = ctWallClockToUtcIso(dateStr, startMin);
      const toUtc = ctWallClockToUtcIso(dateStr, endMin);
      if (!fromUtc || !toUtc) {
        done({ status: 400 });
        return res.status(400).json({ error: 'invalid date' });
      }

      const sql = getDb();
      // We filter on fired_at (when the alert was emitted in CT time)
      // rather than bucket_start so the user gets exactly the slice
      // they asked for. expiry == dateStr enforces 0DTE per the
      // backfill semantics.
      const rawRows = optionType
        ? await sql`
            SELECT id, option_chain, ticker, option_type, strike, expiry,
                   bucket_start, bucket_end, fired_at, ratio_pct,
                   ask_premium, total_premium, trade_count,
                   top_trade_premium, top_trade_size, top_trade_executed_at,
                   top_trade_is_sweep, top_trade_is_floor,
                   underlying_price
            FROM interval_ba_alerts
            WHERE expiry = ${dateStr}
              AND fired_at >= ${fromUtc}
              AND fired_at <  ${toUtc}
              AND option_type = ${optionType}
              AND total_premium >= ${minPremium}
            ORDER BY fired_at DESC
            LIMIT ${MAX_ROWS}
          `
        : await sql`
            SELECT id, option_chain, ticker, option_type, strike, expiry,
                   bucket_start, bucket_end, fired_at, ratio_pct,
                   ask_premium, total_premium, trade_count,
                   top_trade_premium, top_trade_size, top_trade_executed_at,
                   top_trade_is_sweep, top_trade_is_floor,
                   underlying_price
            FROM interval_ba_alerts
            WHERE expiry = ${dateStr}
              AND fired_at >= ${fromUtc}
              AND fired_at <  ${toUtc}
              AND total_premium >= ${minPremium}
            ORDER BY fired_at DESC
            LIMIT ${MAX_ROWS}
          `;
      const rows = rawRows as unknown as RawRow[];

      const alerts = rows.map(shapeRow);
      const summary = buildSummary(alerts);

      res.setHeader('Cache-Control', 'no-store');
      done({ status: 200 });
      return res.status(200).json({ alerts, summary });
    } catch (err) {
      done({ status: 500 });
      Sentry.captureException(err);
      logger.error({ err }, 'interval-ba-feed error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}

export const _internal = { deriveSeverity, shapeRow, buildSummary };
