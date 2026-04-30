/**
 * GET /api/whale-anomalies
 *
 * Owner-or-guest read endpoint backing the Whale Anomalies component
 * (replaces Strike IV Anomalies). Returns whales that match the
 * hand-derived whale-detection checklist (per-ticker p95 premium, ≥85%
 * one-sided, ≥5 trades, ≤14 DTE, ≤5% moneyness, no simultaneous paired leg).
 *
 * Query params:
 *   date     — required, YYYY-MM-DD. Trade-day to fetch whales for.
 *   at       — optional ISO timestamp. Return only whales with
 *              first_ts <= at (for the time scrubber).
 *   ticker   — optional. Filter to a single ticker.
 *
 * Response:
 *   {
 *     date: string,
 *     asOf: string | null,
 *     whales: WhaleAnomaly[],
 *   }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from './_lib/db.js';
import { Sentry } from './_lib/sentry.js';
import logger from './_lib/logger.js';
import {
  guardOwnerOrGuestEndpoint,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { WHALE_TICKERS } from './_lib/whale-detector.js';

interface WhaleAnomalyRow {
  id: number | string;
  ticker: string;
  option_chain: string;
  strike: string | number;
  option_type: 'call' | 'put';
  expiry: string;
  first_ts: string | Date;
  last_ts: string | Date;
  detected_at: string | Date;
  side: 'ASK' | 'BID';
  ask_pct: string | number | null;
  total_premium: string | number;
  trade_count: number;
  vol_oi_ratio: string | number | null;
  underlying_price: string | number | null;
  moneyness: string | number | null;
  dte: number;
  whale_type: number;
  direction: 'bullish' | 'bearish';
  pairing_status: 'alone' | 'sequential';
  source: 'live' | 'eod_backfill';
  resolved_at: string | Date | null;
  hit_target: boolean | null;
  pct_to_target: string | number | null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guarded = await guardOwnerOrGuestEndpoint(req, res, () => undefined);
  if (guarded) return;

  try {
    const date = String(req.query.date ?? '');
    const at = req.query.at ? String(req.query.at) : null;
    const ticker = req.query.ticker ? String(req.query.ticker) : null;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: 'date must be YYYY-MM-DD' });
      return;
    }
    if (ticker && !(WHALE_TICKERS as readonly string[]).includes(ticker)) {
      res.status(400).json({ error: 'invalid ticker' });
      return;
    }
    if (at && Number.isNaN(Date.parse(at))) {
      res.status(400).json({ error: 'at must be ISO timestamp' });
      return;
    }

    const db = getDb();

    // Sentinel for "no time bound" — anything past 23:59 of the date is
    // safely bigger than any first_ts on that day.
    const upperBound = at ?? `${date}T23:59:59.999Z`;

    const rows = (await db`
      SELECT
        id, ticker, option_chain, strike, option_type, expiry,
        first_ts, last_ts, detected_at,
        side, ask_pct, total_premium, trade_count, vol_oi_ratio,
        underlying_price, moneyness, dte,
        whale_type, direction, pairing_status, source,
        resolved_at, hit_target, pct_to_target
      FROM whale_anomalies
      WHERE DATE(first_ts AT TIME ZONE 'UTC') = ${date}
        AND first_ts <= ${upperBound}
        AND (${ticker ?? null}::text IS NULL OR ticker = ${ticker ?? ''})
      ORDER BY first_ts ASC
    `) as WhaleAnomalyRow[];

    const whales = rows.map((r) => ({
      id: Number(r.id),
      ticker: r.ticker,
      option_chain: r.option_chain,
      strike: Number(r.strike),
      option_type: r.option_type,
      expiry:
        r.expiry instanceof Date
          ? r.expiry.toISOString().slice(0, 10)
          : String(r.expiry).slice(0, 10),
      first_ts:
        r.first_ts instanceof Date ? r.first_ts.toISOString() : r.first_ts,
      last_ts:
        r.last_ts instanceof Date ? r.last_ts.toISOString() : r.last_ts,
      detected_at:
        r.detected_at instanceof Date
          ? r.detected_at.toISOString()
          : r.detected_at,
      side: r.side,
      ask_pct: r.ask_pct != null ? Number(r.ask_pct) : null,
      total_premium: Number(r.total_premium),
      trade_count: Number(r.trade_count),
      vol_oi_ratio: r.vol_oi_ratio != null ? Number(r.vol_oi_ratio) : null,
      underlying_price:
        r.underlying_price != null ? Number(r.underlying_price) : null,
      moneyness: r.moneyness != null ? Number(r.moneyness) : null,
      dte: Number(r.dte),
      whale_type: Number(r.whale_type),
      direction: r.direction,
      pairing_status: r.pairing_status,
      source: r.source,
      resolved_at: r.resolved_at
        ? r.resolved_at instanceof Date
          ? r.resolved_at.toISOString()
          : r.resolved_at
        : null,
      hit_target: r.hit_target,
      pct_to_target: r.pct_to_target != null ? Number(r.pct_to_target) : null,
    }));

    setCacheHeaders(res, 60, 60);
    res.status(200).json({
      date,
      asOf: at,
      whales,
    });
  } catch (err) {
    Sentry.captureException(err);
    logger.error({ err }, 'whale-anomalies error');
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
