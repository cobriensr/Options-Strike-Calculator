/**
 * GET /api/cron/detect-whales
 *
 * Reads new whale_alerts rows since the last detection cycle, classifies
 * each against the whale-detection checklist (api/_lib/whale-detector.ts),
 * detects same-strike opposite-side pairing (sequential vs simultaneous),
 * and inserts qualifying rows into whale_anomalies with source='live'.
 *
 * Runs every minute during market hours (after fetch-whale-alerts each
 * 5-min cycle has had a chance to populate fresh data).
 *
 * Strategy:
 *   1. Read MAX(detected_at) from whale_anomalies WHERE source='live'.
 *   2. SELECT whale_alerts rows with created_at > since (or all on first run).
 *   3. For each candidate, classify; if passes, look up same-day same-strike
 *      same-expiry opposite-side rows (whale_alerts + flow_alerts) for
 *      pairing detection. Drop simultaneous synthetics.
 *   4. Insert with ON CONFLICT (option_chain, first_ts) DO NOTHING.
 *
 * Environment: CRON_SECRET (no UW_API_KEY needed — DB-only).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { cronGuard } from '../_lib/api-helpers.js';
import { getDb } from '../_lib/db.js';
import {
  classifyWhale,
  detectPairing,
  WHALE_TICKERS,
  type WhaleCandidate,
  type PairingPeer,
} from '../_lib/whale-detector.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';

type DbId = number | string;
type DbNumeric = string | number;
type DbNullableNumeric = DbNumeric | null;
type DbTimestamp = string | Date;
type DbOptionType = 'call' | 'put';

interface WhaleAlertRow {
  id: DbId;
  ticker: string;
  option_chain: string;
  strike: DbNumeric;
  option_type: DbOptionType;
  expiry: string;
  created_at: DbTimestamp;
  total_premium: DbNumeric;
  total_ask_side_prem: DbNullableNumeric;
  total_bid_side_prem: DbNullableNumeric;
  trade_count: number;
  underlying_price: DbNullableNumeric;
  volume_oi_ratio: DbNullableNumeric;
  dte_at_alert: number | null;
}

interface PeerRow {
  option_type: DbOptionType;
  first_ts: DbTimestamp;
  last_ts: DbTimestamp;
}

function rowToCandidate(row: WhaleAlertRow): WhaleCandidate {
  const created = new Date(row.created_at);
  const askPrem = row.total_ask_side_prem != null ? Number(row.total_ask_side_prem) : 0;
  const bidPrem = row.total_bid_side_prem != null ? Number(row.total_bid_side_prem) : 0;
  const underlying =
    row.underlying_price != null ? Number(row.underlying_price) : null;
  const volOi =
    row.volume_oi_ratio != null ? Number(row.volume_oi_ratio) : null;
  return {
    ticker: row.ticker,
    option_chain: row.option_chain,
    strike: Number(row.strike),
    option_type: row.option_type,
    expiry: row.expiry,
    first_ts: created,
    last_ts: created,
    side_ask_premium: askPrem,
    side_bid_premium: bidPrem,
    total_premium: Number(row.total_premium),
    trade_count: Number(row.trade_count),
    underlying_price: underlying,
    vol_oi_ratio: volOi,
    dte: row.dte_at_alert ?? 0,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res, { requireApiKey: false });
  if (!guard) return;
  const startedAt = Date.now();

  try {
    const db = getDb();

    // 1. Last-seen cursor.
    const cursorRows = (await db`
      SELECT MAX(detected_at) AS max_detected_at
      FROM whale_anomalies
      WHERE source = 'live'
    `) as { max_detected_at: Date | string | null }[];
    const sinceRaw = cursorRows[0]?.max_detected_at ?? null;
    const since =
      sinceRaw instanceof Date ? sinceRaw.toISOString() : (sinceRaw ?? null);

    // 2. Pull new whale_alerts. We use ingested_at (when we logged the row
    //    locally) rather than created_at so we don't miss late-arriving
    //    out-of-order alerts. Sentinel epoch on first run (no prior cycles).
    const sinceTs = since ?? '1970-01-01T00:00:00Z';
    const candidates = (await db`
      SELECT
        id, ticker, option_chain, strike, type AS option_type, expiry,
        created_at, total_premium, total_ask_side_prem, total_bid_side_prem,
        trade_count, underlying_price, volume_oi_ratio, dte_at_alert
      FROM whale_alerts
      WHERE ticker = ANY(${[...WHALE_TICKERS]})
        AND ingested_at > ${sinceTs}
      ORDER BY created_at ASC
      LIMIT 500
    `) as WhaleAlertRow[];

    if (candidates.length === 0) {
      return res.status(200).json({
        job: 'detect-whales',
        candidates: 0,
        inserted: 0,
        durationMs: Date.now() - startedAt,
      });
    }

    let inserted = 0;
    let classifiedCount = 0;
    let simultaneousFiltered = 0;

    for (const row of candidates) {
      const candidate = rowToCandidate(row);
      const classification = classifyWhale(candidate);
      if (!classification) continue;
      classifiedCount++;

      // 3. Pairing peers: same-day same-strike same-expiry opposite-type rows
      //    drawn from whale_alerts AND flow_alerts (broader coverage).
      const expiryStr = String(row.expiry).slice(0, 10);
      const tradeDate = String(row.created_at).slice(0, 10);
      const oppositeType = candidate.option_type === 'call' ? 'put' : 'call';

      const peers = (await db`
        SELECT type AS option_type, MIN(created_at) AS first_ts, MAX(created_at) AS last_ts
        FROM (
          SELECT type, created_at FROM whale_alerts
          WHERE ticker = ${candidate.ticker}
            AND strike = ${candidate.strike}
            AND expiry = ${expiryStr}
            AND DATE(created_at AT TIME ZONE 'UTC') = ${tradeDate}
            AND type = ${oppositeType}
          UNION ALL
          SELECT type, created_at FROM flow_alerts
          WHERE ticker = ${candidate.ticker}
            AND strike = ${candidate.strike}
            AND expiry = ${expiryStr}
            AND DATE(created_at AT TIME ZONE 'UTC') = ${tradeDate}
            AND type = ${oppositeType}
        ) AS u
        GROUP BY type
      `) as PeerRow[];

      const peerInputs: PairingPeer[] = peers.map((p) => ({
        option_type: p.option_type,
        first_ts: new Date(p.first_ts),
        last_ts: new Date(p.last_ts),
      }));

      const pairing = detectPairing(
        {
          first_ts: candidate.first_ts,
          last_ts: candidate.last_ts,
          option_type: candidate.option_type,
        },
        peerInputs,
      );

      if (pairing === 'simultaneous_filtered') {
        simultaneousFiltered++;
        continue;
      }

      // 4. Insert.
      const result = (await db`
        INSERT INTO whale_anomalies (
          source_alert_id, source, ticker, option_chain, strike, option_type,
          expiry, first_ts, last_ts, side, ask_pct, total_premium, trade_count,
          vol_oi_ratio, underlying_price, moneyness, dte,
          whale_type, direction, pairing_status
        ) VALUES (
          ${row.id}, 'live', ${candidate.ticker}, ${candidate.option_chain},
          ${candidate.strike}, ${candidate.option_type}, ${expiryStr},
          ${candidate.first_ts.toISOString()}, ${candidate.last_ts.toISOString()},
          ${classification.side}, ${classification.ask_pct},
          ${candidate.total_premium}, ${candidate.trade_count},
          ${candidate.vol_oi_ratio}, ${candidate.underlying_price},
          ${classification.moneyness}, ${candidate.dte},
          ${classification.whale_type}, ${classification.direction}, ${pairing}
        )
        ON CONFLICT (option_chain, first_ts) DO NOTHING
        RETURNING id
      `) as { id: number }[];
      if (result.length > 0) inserted++;
    }

    logger.info(
      {
        candidates: candidates.length,
        classified: classifiedCount,
        simultaneousFiltered,
        inserted,
      },
      'detect-whales completed',
    );

    return res.status(200).json({
      job: 'detect-whales',
      candidates: candidates.length,
      classified: classifiedCount,
      simultaneousFiltered,
      inserted,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'detect-whales');
    Sentry.captureException(err);
    logger.error({ err }, 'detect-whales error');
    return res.status(500).json({
      job: 'detect-whales',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
