/**
 * GET /api/cron/resolve-whales
 *
 * Resolves outcome columns (resolved_at, hit_target, pct_close_vs_strike) for
 * unresolved whale_anomalies rows by checking how the underlying behaved
 * after the print fired.
 *
 * Hit semantics by whale_type:
 *   Type 1 (BID put, floor declared)        — hit if price stayed above strike
 *   Type 2 (BID call, ceiling declared)     — hit if price stayed below strike
 *   Type 3 (ASK put, floor break expected)  — hit if price went below strike
 *   Type 4 (ASK call, ceiling break expected) — hit if price went above strike
 *
 * Underlying price source: flow_alerts.underlying_price + whale_alerts
 * .underlying_price for the same ticker × same trade-day, after the whale's
 * first_ts. Aggregated as min/max/last to derive intraday extremes and
 * approximate close.
 *
 * Schedule: every minute during market hours (* 13-21 * * 1-5) — keeps
 * resolution running near-real-time so the UI can show outcomes within
 * minutes. Idempotent; only updates rows still NULL on resolved_at.
 *
 * Environment: CRON_SECRET (DB-only).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { cronGuard } from '../_lib/api-helpers.js';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';

type DbId = number | string;
type DbNumeric = string | number;
type DbNullableNumeric = DbNumeric | null;
type DbTimestamp = Date | string;

interface UnresolvedRow {
  id: DbId;
  ticker: string;
  strike: DbNumeric;
  whale_type: number;
  underlying_price: DbNullableNumeric;
  first_ts: DbTimestamp;
  trade_date: string;
}

interface RangeRow {
  hi: DbNullableNumeric;
  lo: DbNullableNumeric;
  last: DbNullableNumeric;
  n: number;
}

function determineHit(
  whaleType: number,
  strike: number,
  hi: number,
  lo: number,
  last: number,
): { hit: boolean; pctCloseVsStrike: number } {
  // Boundary semantics: price touching the strike exactly counts as a hit.
  // pctCloseVsStrike is the close vs strike percentage in the favorable
  // direction — positive when the trade played out as expected.
  switch (whaleType) {
    case 1:
      // Floor declared: hit if low ≥ strike (price stayed at or above strike).
      return { hit: lo >= strike, pctCloseVsStrike: (last - strike) / strike };
    case 2:
      // Ceiling declared: hit if high ≤ strike (price stayed at or below).
      return { hit: hi <= strike, pctCloseVsStrike: (strike - last) / strike };
    case 3:
      // Floor break expected: hit if low ≤ strike (price touched or broke).
      return { hit: lo <= strike, pctCloseVsStrike: (strike - last) / strike };
    case 4:
      // Ceiling break expected: hit if high ≥ strike (price touched or broke).
      return { hit: hi >= strike, pctCloseVsStrike: (last - strike) / strike };
    default:
      return { hit: false, pctCloseVsStrike: 0 };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res, { requireApiKey: false });
  if (!guard) return;
  const startedAt = Date.now();

  try {
    const db = getDb();

    // 1. Pull unresolved whales from the last 7 days. Skip rows from less
    //    than 5 minutes ago — give the underlying time to print.
    const unresolved = (await db`
      SELECT
        id, ticker, strike, whale_type, underlying_price, first_ts,
        DATE(first_ts AT TIME ZONE 'UTC')::text AS trade_date
      FROM whale_anomalies
      WHERE resolved_at IS NULL
        AND first_ts > now() - INTERVAL '7 days'
        AND first_ts < now() - INTERVAL '5 minutes'
      ORDER BY first_ts ASC
      LIMIT 200
    `) as UnresolvedRow[];

    if (unresolved.length === 0) {
      return res.status(200).json({
        job: 'resolve-whales',
        unresolved: 0,
        resolved: 0,
        durationMs: Date.now() - startedAt,
      });
    }

    let resolved = 0;
    let skipped = 0;

    for (const w of unresolved) {
      const strike = Number(w.strike);
      const firstTs =
        w.first_ts instanceof Date ? w.first_ts : new Date(w.first_ts);

      // 2. Pull underlying-price extremes from flow_alerts + whale_alerts
      //    after the whale's first_ts on the same day.
      const range = (await db`
        WITH u AS (
          SELECT underlying_price::numeric AS p, created_at
          FROM flow_alerts
          WHERE ticker = ${w.ticker}
            AND created_at > ${firstTs.toISOString()}
            AND DATE(created_at AT TIME ZONE 'UTC') = ${w.trade_date}
            AND underlying_price IS NOT NULL
          UNION ALL
          SELECT underlying_price::numeric, created_at
          FROM whale_alerts
          WHERE ticker = ${w.ticker}
            AND created_at > ${firstTs.toISOString()}
            AND DATE(created_at AT TIME ZONE 'UTC') = ${w.trade_date}
            AND underlying_price IS NOT NULL
        )
        SELECT
          MAX(p)::float8 AS hi,
          MIN(p)::float8 AS lo,
          (SELECT p::float8 FROM u ORDER BY created_at DESC LIMIT 1) AS last,
          COUNT(*)::int AS n
        FROM u
      `) as RangeRow[];

      const r = range[0];
      if (!r || !r.n || r.hi == null || r.lo == null || r.last == null) {
        skipped++;
        continue;
      }

      const hi = Number(r.hi);
      const lo = Number(r.lo);
      const last = Number(r.last);
      const { hit, pctCloseVsStrike } = determineHit(
        Number(w.whale_type),
        strike,
        hi,
        lo,
        last,
      );

      await db`
        UPDATE whale_anomalies
        SET resolved_at = now(),
            hit_target = ${hit},
            pct_close_vs_strike = ${pctCloseVsStrike}
        WHERE id = ${w.id}
      `;
      resolved++;
    }

    logger.info(
      { unresolved: unresolved.length, resolved, skipped },
      'resolve-whales completed',
    );

    return res.status(200).json({
      job: 'resolve-whales',
      unresolved: unresolved.length,
      resolved,
      skipped,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'resolve-whales');
    Sentry.captureException(err);
    logger.error({ err }, 'resolve-whales error');
    return res.status(500).json({
      job: 'resolve-whales',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
