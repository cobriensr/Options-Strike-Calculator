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
 *   ?confluenceOnly=1      — only fires with ≥1 cross-symbol partner
 *                            (alerts whose confluence_tickers is non-empty)
 *   ?moneyness=ITM|OTM     — filter by per-row moneyness state derived
 *                            from the (option_type, strike, spot) triplet
 *                            after the SPXW→SPX spot fallback below.
 *                            ATM (within ±0.05% of strike) is excluded
 *                            from both ITM-only and OTM-only filters.
 *
 * SPXW underlying_price fallback:
 *   UW does not emit an underlying price on SPXW ticks (SPXW isn't a
 *   tradable underlying — only the index option chain is). So the
 *   uw-stream daemon stores NULL for every SPXW row. SPY/QQQ rows have
 *   the price inline because UW sends it. To make ITM/OTM render
 *   consistently across all three tickers we LEFT JOIN LATERAL the
 *   nearest-prior 1m SPX candle (symbol='SPX', date=expiry,
 *   timestamp ≤ fired_at) and COALESCE into underlying_price. The JOIN
 *   is a no-op for SPY/QQQ rows because the lateral subquery's
 *   `ticker = 'SPXW'` guard returns no rows.
 *
 * Response:
 *   {
 *     alerts:  IntervalBAFeedAlert[],
 *     summary: { count, total_premium, extreme, critical, warning }
 *   }
 *
 * Each FeedAlert carries a `confluence_tickers: string[]` field — the
 * SPY/SPXW/QQQ trio members (other than the alert's own ticker) that
 * fired same-direction within the configured ±90s window. Legacy rows
 * pre-Phase-3 collapse to []. See migration #147 + Phase 3 spec.
 *
 * Spec: docs/superpowers/specs/interval-ba-ask-alert-2026-05-12.md.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb, withDbRetry } from './_lib/db.js';
import { Sentry, metrics } from './_lib/sentry.js';
import { sendDbErrorResponse } from './_lib/transient-db-response.js';
import { guardOwnerOrGuestEndpoint } from './_lib/api-helpers.js';
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
  // Cross-symbol confluence (Phase 5 of interval-ba-confluence spec).
  // Empty list for solo fires, populated when a partner ETF / index
  // fired same-direction within the configured window. Migration #147
  // added the column nullable; legacy backfilled rows surface as [].
  confluence_tickers: string[];
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
  // BIGSERIAL — Neon returns BIGINT as string. Coerced to number in
  // shapeRow so the API contract matches the FeedAlert.id: number type
  // and stays consistent with /api/interval-ba-alerts.
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
  // Neon serializes TEXT[] as a JS string[]; legacy rows (pre-Phase-3
  // populate) surface as null. We coalesce to [] in shapeRow().
  confluence_tickers: string[] | null;
}

function shapeRow(r: RawRow): FeedAlert {
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

      // Phase 5: optional filter to only confluence (multi-symbol) fires.
      // Pushed into the SQL WHERE via the `IS NULL OR ...` sentinel
      // pattern so the MAX_ROWS=500 LIMIT operates against the filtered
      // set, not the full universe. The earlier JS-side post-filter was
      // silently truncating: 800 alerts ÷ 50 confluence meant the user
      // could get only the confluence fires that happened to be in the
      // top-500-by-fired_at, depending on the day's mix. The cardinality
      // predicate is not GIN-indexable (GIN serves @>, <@, &&, = ANY),
      // so the planner uses a seq scan + filter on the rowset already
      // bounded by the (expiry, fired_at) range index — acceptable
      // because a day's interval_ba_alerts is on the order of 10^3 rows.
      const confluenceOnly = req.query.confluenceOnly === '1';
      const confluenceFilterTok: string | null = confluenceOnly ? '1' : null;

      // Moneyness filter — NULL means "off" so the gate compiles to
      // `(NULL IS NULL OR …)` which short-circuits to TRUE. Anything
      // other than the exact strings 'ITM' / 'OTM' is treated as off.
      const moneynessRaw = req.query.moneyness as string | undefined;
      const moneynessFilter: 'ITM' | 'OTM' | null =
        moneynessRaw === 'ITM' || moneynessRaw === 'OTM' ? moneynessRaw : null;

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
      //
      // The LEFT JOIN LATERAL pulls the closest 1m SPX candle at or
      // before fired_at for SPXW rows; SPY/QQQ rows skip the lookup
      // because the inner `a.ticker = 'SPXW'` guard yields no match.
      // The COALESCE means we expose `effective_spot` which the
      // frontend reads as underlying_price — the on-disk column stays
      // untouched. moneyness_state in the SELECT is the same logic the
      // pill renders client-side, recomputed in SQL so the gate can use
      // it in WHERE without redundant client filtering.
      const rawRows = await withDbRetry(
        () =>
          optionType
            ? sql`
            WITH base AS (
              SELECT a.*,
                COALESCE(a.underlying_price, spx.close)::numeric AS effective_spot
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
              WHERE a.expiry = ${dateStr}
                AND a.fired_at >= ${fromUtc}
                AND a.fired_at <  ${toUtc}
                AND a.option_type = ${optionType}
                AND a.total_premium >= ${minPremium}
                AND (${confluenceFilterTok}::text IS NULL OR (
                  a.confluence_tickers IS NOT NULL
                  AND cardinality(a.confluence_tickers) > 0
                ))
            )
            SELECT id, option_chain, ticker, option_type, strike, expiry,
                   bucket_start, bucket_end, fired_at, ratio_pct,
                   ask_premium, total_premium, trade_count,
                   top_trade_premium, top_trade_size, top_trade_executed_at,
                   top_trade_is_sweep, top_trade_is_floor,
                   effective_spot AS underlying_price,
                   confluence_tickers
            FROM base
            WHERE (${moneynessFilter}::text IS NULL OR (
              effective_spot IS NOT NULL
              AND effective_spot > 0
              AND ABS(
                CASE WHEN option_type = 'C'
                  THEN effective_spot - strike
                  ELSE strike - effective_spot
                END
              ) / effective_spot * 100 > 0.05
              AND (
                (${moneynessFilter}::text = 'ITM' AND (
                  (option_type = 'C' AND effective_spot > strike)
                  OR (option_type = 'P' AND strike > effective_spot)
                ))
                OR (${moneynessFilter}::text = 'OTM' AND (
                  (option_type = 'C' AND effective_spot < strike)
                  OR (option_type = 'P' AND strike < effective_spot)
                ))
              )
            ))
            ORDER BY fired_at DESC
            LIMIT ${MAX_ROWS}
          `
            : sql`
            WITH base AS (
              SELECT a.*,
                COALESCE(a.underlying_price, spx.close)::numeric AS effective_spot
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
              WHERE a.expiry = ${dateStr}
                AND a.fired_at >= ${fromUtc}
                AND a.fired_at <  ${toUtc}
                AND a.total_premium >= ${minPremium}
                AND (${confluenceFilterTok}::text IS NULL OR (
                  a.confluence_tickers IS NOT NULL
                  AND cardinality(a.confluence_tickers) > 0
                ))
            )
            SELECT id, option_chain, ticker, option_type, strike, expiry,
                   bucket_start, bucket_end, fired_at, ratio_pct,
                   ask_premium, total_premium, trade_count,
                   top_trade_premium, top_trade_size, top_trade_executed_at,
                   top_trade_is_sweep, top_trade_is_floor,
                   effective_spot AS underlying_price,
                   confluence_tickers
            FROM base
            WHERE (${moneynessFilter}::text IS NULL OR (
              effective_spot IS NOT NULL
              AND effective_spot > 0
              AND ABS(
                CASE WHEN option_type = 'C'
                  THEN effective_spot - strike
                  ELSE strike - effective_spot
                END
              ) / effective_spot * 100 > 0.05
              AND (
                (${moneynessFilter}::text = 'ITM' AND (
                  (option_type = 'C' AND effective_spot > strike)
                  OR (option_type = 'P' AND strike > effective_spot)
                ))
                OR (${moneynessFilter}::text = 'OTM' AND (
                  (option_type = 'C' AND effective_spot < strike)
                  OR (option_type = 'P' AND strike < effective_spot)
                ))
              )
            ))
            ORDER BY fired_at DESC
            LIMIT ${MAX_ROWS}
          `,
        2,
        10_000,
      );
      const rows = rawRows as unknown as RawRow[];

      const alerts = rows.map(shapeRow);
      const summary = buildSummary(alerts);

      res.setHeader('Cache-Control', 'no-store');
      done({ status: 200 });
      return res.status(200).json({ alerts, summary });
    } catch (err) {
      done({ status: 500 });
      sendDbErrorResponse(res, err, {
        label: 'interval_ba_feed',
        serverErrorBody: { error: 'Internal error' },
      });
      return;
    }
  });
}

export const _internal = { deriveSeverity, shapeRow, buildSummary };
