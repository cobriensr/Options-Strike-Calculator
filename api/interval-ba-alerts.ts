/**
 * GET /api/interval-ba-alerts
 *
 * Returns recent SPXW Interval B/A ask-side alerts emitted by the
 * uw-stream SPXWIntervalBAHandler. Polled by the frontend every 10
 * seconds during market hours to drive in-app banner + audio cue +
 * browser notification for high-conviction ask-side flow.
 *
 * Owner-or-guest — alert data derives from UW WS option_trades stream
 * (OPRA compliance, same provenance as /api/alerts).
 *
 * Query params:
 *   ?since=ISO8601  — return alerts with fired_at > this timestamp
 *   (default: all unacknowledged alerts for today's expiry, max 20)
 *
 * Response shape:
 *   { alerts: IntervalBAAlertRow[] }
 *
 * `severity` is derived per row from total_premium so the frontend
 * can pick chime tone + repeat cadence without re-deriving:
 *   - total_premium >= $1M  → 'extreme'
 *   - total_premium >= $500K → 'critical'
 *   - else                    → 'warning'
 *
 * NUMERIC columns are coerced to JS numbers in the response so
 * consumers don't have to parse strings. `bucket_start`/`bucket_end`/
 * `fired_at`/`top_trade_executed_at` stay as ISO strings (the Neon
 * driver already produces Date instances; we ISO-stringify for
 * stable JSON shape across runtimes).
 *
 * Each row carries `confluence_tickers: string[]` (Phase 5 of
 * interval-ba-confluence spec) — partner tickers from the SPY/SPXW/QQQ
 * trio that fired same-direction within the configured window. Legacy
 * rows pre-Phase-3 surface as []. See migration #147.
 *
 * Spec: docs/superpowers/specs/interval-ba-ask-alert-2026-05-12.md
 * Schema: api/_lib/db-migrations.ts migration #144 + #147.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb, withDbRetry } from './_lib/db.js';
import { Sentry, metrics } from './_lib/sentry.js';
import { guardOwnerOrGuestEndpoint } from './_lib/api-helpers.js';
import logger from './_lib/logger.js';
import { getETDateStr } from '../src/utils/timezone.js';

type Severity = 'extreme' | 'critical' | 'warning';

interface IntervalBAAlertRow {
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
  // Phase 5 — partner tickers (SPY/SPXW/QQQ) that fired same-direction
  // within the confluence window. Empty list for solo fires; null on
  // legacy rows pre-Phase-3 collapses to []. See migration #147 + the
  // uw-stream RecentFires registry.
  confluence_tickers: string[];
  acknowledged: boolean;
  severity: Severity;
}

const EXTREME_THRESHOLD = 1_000_000;
const CRITICAL_THRESHOLD = 500_000;

function deriveSeverity(totalPremium: number): Severity {
  if (totalPremium >= EXTREME_THRESHOLD) return 'extreme';
  if (totalPremium >= CRITICAL_THRESHOLD) return 'critical';
  return 'warning';
}

function toNumber(v: unknown): number {
  // Neon's `@neondatabase/serverless` driver returns NUMERIC as strings
  // to preserve precision. We're displaying these in the UI as money
  // and ratios; native JS Number is the right shape for the frontend.
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number.parseFloat(v);
  return 0;
}

function toNumberOrNull(v: unknown): number | null {
  if (v == null) return null;
  return toNumber(v);
}

function toIsoOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  return null;
}

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  return '';
}

interface RawRow {
  // BIGSERIAL — Neon's @neondatabase/serverless returns BIGINT as string
  // to preserve precision. shapeRow coerces to JS number for the API
  // response so the frontend (which types `id: number`) can round-trip
  // it through JSON.stringify to /api/interval-ba-alerts-ack without
  // tripping the Zod number-not-string check. Safe coercion: alert IDs
  // won't exceed Number.MAX_SAFE_INTEGER for centuries at any realistic
  // fire rate.
  id: string | number;
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
  confluence_tickers: string[] | null;
  acknowledged: boolean;
}

function shapeRow(r: RawRow): IntervalBAAlertRow {
  const total_premium = toNumber(r.total_premium);
  return {
    id: toNumber(r.id),
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
    confluence_tickers: r.confluence_tickers ?? [],
    acknowledged: r.acknowledged,
    severity: deriveSeverity(total_premium),
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/interval-ba-alerts');
    const done = metrics.request('/api/interval-ba-alerts');

    try {
      if (req.method !== 'GET') {
        done({ status: 405 });
        return res.status(405).json({ error: 'GET only' });
      }

      if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

      const sql = getDb();
      const since = req.query.since as string | undefined;
      const today = getETDateStr(new Date());

      // Neon's serverless `sql` tag returns `Record<string, any>[]`;
      // the SELECT list matches RawRow exactly so a cast is safe.
      //
      // SPXW underlying_price fallback: UW does not emit a spot on
      // SPXW ticks (SPXW is the index option chain, not a tradable
      // underlying), so the daemon writes NULL. We LEFT JOIN LATERAL
      // the nearest-prior 1m SPX candle (symbol='SPX', date=expiry,
      // timestamp ≤ fired_at) and COALESCE so SPXW rows render their
      // ITM/OTM pill consistently with SPY/QQQ rows. The lateral
      // subquery short-circuits on non-SPXW tickers via the inner
      // `a.ticker = 'SPXW'` guard, so SPY/QQQ rows pay no JOIN cost.
      const rawRows = since
        ? await withDbRetry(
            () => sql`
            SELECT a.id, a.option_chain, a.ticker, a.option_type, a.strike,
                   a.expiry, a.bucket_start, a.bucket_end, a.fired_at,
                   a.ratio_pct, a.ask_premium, a.total_premium, a.trade_count,
                   a.top_trade_premium, a.top_trade_size,
                   a.top_trade_executed_at, a.top_trade_is_sweep,
                   a.top_trade_is_floor,
                   COALESCE(a.underlying_price, spx.close)::numeric AS underlying_price,
                   a.confluence_tickers, a.acknowledged
            FROM interval_ba_alerts a
            LEFT JOIN LATERAL (
              SELECT close
              FROM index_candles_1m c
              WHERE a.ticker = 'SPXW'
                AND c.symbol = 'SPX'
                AND c.date = a.expiry
                AND c.timestamp <= a.fired_at
              ORDER BY c.timestamp DESC
              LIMIT 1
            ) spx ON TRUE
            WHERE a.fired_at > ${since}
            ORDER BY a.fired_at DESC
            LIMIT 20
          `,
            2,
            10_000,
          )
        : await withDbRetry(
            () => sql`
            SELECT a.id, a.option_chain, a.ticker, a.option_type, a.strike,
                   a.expiry, a.bucket_start, a.bucket_end, a.fired_at,
                   a.ratio_pct, a.ask_premium, a.total_premium, a.trade_count,
                   a.top_trade_premium, a.top_trade_size,
                   a.top_trade_executed_at, a.top_trade_is_sweep,
                   a.top_trade_is_floor,
                   COALESCE(a.underlying_price, spx.close)::numeric AS underlying_price,
                   a.confluence_tickers, a.acknowledged
            FROM interval_ba_alerts a
            LEFT JOIN LATERAL (
              SELECT close
              FROM index_candles_1m c
              WHERE a.ticker = 'SPXW'
                AND c.symbol = 'SPX'
                AND c.date = a.expiry
                AND c.timestamp <= a.fired_at
              ORDER BY c.timestamp DESC
              LIMIT 1
            ) spx ON TRUE
            WHERE a.expiry = ${today} AND NOT a.acknowledged
            ORDER BY a.fired_at DESC
            LIMIT 20
          `,
            2,
            10_000,
          );
      const rows = rawRows as unknown as RawRow[];

      const alerts = rows.map(shapeRow);

      res.setHeader('Cache-Control', 'no-store');
      done({ status: 200 });
      return res.status(200).json({ alerts });
    } catch (err) {
      done({ status: 500 });
      Sentry.captureException(err);
      logger.error({ err }, 'interval-ba-alerts fetch error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}

// Exported for unit tests.
export const _internal = { deriveSeverity, shapeRow };
