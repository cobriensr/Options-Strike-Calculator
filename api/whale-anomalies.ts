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

type DbId = number | string;
type DbNumeric = string | number;
type DbNullableNumeric = DbNumeric | null;
type DbTimestamp = string | Date;
type DbNullableTimestamp = DbTimestamp | null;
type DbOptionType = 'call' | 'put';
type DbWhaleSide = 'ASK' | 'BID';
type DbDirection = 'bullish' | 'bearish';
type DbPairingStatus = 'alone' | 'sequential';
type DbSource = 'live' | 'eod_backfill';

interface WhaleAnomalyRow {
  id: DbId;
  ticker: string;
  option_chain: string;
  strike: DbNumeric;
  option_type: DbOptionType;
  expiry: string;
  first_ts: DbTimestamp;
  last_ts: DbTimestamp;
  detected_at: DbTimestamp;
  side: DbWhaleSide;
  ask_pct: DbNullableNumeric;
  total_premium: DbNumeric;
  trade_count: number;
  vol_oi_ratio: DbNullableNumeric;
  underlying_price: DbNullableNumeric;
  moneyness: DbNullableNumeric;
  dte: number;
  whale_type: number;
  direction: DbDirection;
  pairing_status: DbPairingStatus;
  source: DbSource;
  resolved_at: DbNullableTimestamp;
  hit_target: boolean | null;
  pct_close_vs_strike: DbNullableNumeric;
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
        resolved_at, hit_target, pct_close_vs_strike
      FROM whale_anomalies
      WHERE DATE(first_ts AT TIME ZONE 'UTC') = ${date}
        AND first_ts <= ${upperBound}
        AND (${ticker ?? null}::text IS NULL OR ticker = ${ticker ?? ''})
      ORDER BY first_ts ASC
    `) as WhaleAnomalyRow[];

    const toIso = (v: DbTimestamp): string =>
      typeof v === 'string' ? v : v.toISOString();

    const whales = rows.map((r) => ({
      id: Number(r.id),
      ticker: r.ticker,
      option_chain: r.option_chain,
      strike: Number(r.strike),
      option_type: r.option_type,
      expiry: toIso(r.expiry).slice(0, 10),
      first_ts: toIso(r.first_ts),
      last_ts: toIso(r.last_ts),
      detected_at: toIso(r.detected_at),
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
      resolved_at: r.resolved_at != null ? toIso(r.resolved_at) : null,
      hit_target: r.hit_target,
      pct_close_vs_strike:
        r.pct_close_vs_strike != null ? Number(r.pct_close_vs_strike) : null,
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
