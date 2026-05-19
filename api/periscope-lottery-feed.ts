/**
 * GET /api/periscope-lottery-feed
 *
 * Read endpoint backing the two-panel Periscope Lottery UI. Returns
 * recent fires from `periscope_lottery_fires` for the requested date
 * and fire_type, with realized outcomes when the enrichment cron has
 * filled them in.
 *
 * Owner-or-guest. Same auth pattern as /api/silent-boom-feed.
 *
 * Query params:
 *   - date (YYYY-MM-DD, default = today in ET)
 *   - fire_type ('call_lottery' | 'put_lottery' | 'both', default 'both')
 *   - limit (default 100, max 500)
 *
 * Spec: docs/superpowers/specs/periscope-lottery-alerts-2026-05-19.md
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb, withDbRetry } from './_lib/db.js';
import { Sentry } from './_lib/sentry.js';
import logger from './_lib/logger.js';
import {
  guardOwnerOrGuestEndpoint,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { getETDateStr } from '../src/utils/timezone.js';

type DbNumeric = string | number;
type DbTimestamp = string | Date;
type DbFireType = 'call_lottery' | 'put_lottery';

interface FireRow {
  id: number;
  fire_type: DbFireType;
  fire_time: DbTimestamp;
  expiry: string;
  event_strike: number;
  trade_strike: number;
  spot_at_event: DbNumeric;
  strike_dist: DbNumeric;
  greek_post: DbNumeric;
  greek_delta: DbNumeric;
  greek_lvl_rank: DbNumeric | null;
  greek_chg_rank: DbNumeric | null;
  gex_dollars: DbNumeric | null;
  call_ratio: DbNumeric | null;
  qqq_net_prem_balance_30m: DbNumeric | null;
  entry_px: DbNumeric | null;
  vix: DbNumeric | null;
  v3_strict_pass: boolean;
  v4_badge: boolean;
  peak_px: DbNumeric | null;
  peak_pct: DbNumeric | null;
  peak_time: DbTimestamp | null;
  eod_close_px: DbNumeric | null;
  realized_r_peak: DbNumeric | null;
  realized_r_eod: DbNumeric | null;
  outcome_locked: boolean;
  created_at: DbTimestamp;
}

const toNum = (v: DbNumeric | null | undefined): number | null =>
  v == null ? null : typeof v === 'number' ? v : Number(v);

const toIso = (v: DbTimestamp | null): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : String(v);

function serializeFire(r: FireRow) {
  return {
    id: r.id,
    fireType: r.fire_type,
    fireTime: toIso(r.fire_time)!,
    expiry: r.expiry,
    eventStrike: r.event_strike,
    tradeStrike: r.trade_strike,
    spotAtEvent: toNum(r.spot_at_event)!,
    strikeDist: toNum(r.strike_dist)!,
    greekPost: toNum(r.greek_post)!,
    greekDelta: toNum(r.greek_delta)!,
    greekLvlRank: toNum(r.greek_lvl_rank),
    greekChgRank: toNum(r.greek_chg_rank),
    gexDollars: toNum(r.gex_dollars),
    callRatio: toNum(r.call_ratio),
    qqqNetPremBalance30m: toNum(r.qqq_net_prem_balance_30m),
    entryPx: toNum(r.entry_px),
    vix: toNum(r.vix),
    v3StrictPass: Boolean(r.v3_strict_pass),
    v4Badge: Boolean(r.v4_badge),
    peakPx: toNum(r.peak_px),
    peakPct: toNum(r.peak_pct),
    peakTime: toIso(r.peak_time),
    eodClosePx: toNum(r.eod_close_px),
    realizedRPeak: toNum(r.realized_r_peak),
    realizedREod: toNum(r.realized_r_eod),
    outcomeLocked: Boolean(r.outcome_locked),
    createdAt: toIso(r.created_at)!,
  };
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  // Owner-or-guest gate (matches silent-boom-feed pattern). Returns
  // `true` when the guard rejected the request and already sent a 401;
  // we MUST bail without writing a second response.
  const guarded = await guardOwnerOrGuestEndpoint(req, res, () => undefined);
  if (guarded) return;

  try {
    const q = req.query ?? {};
    const dateParam =
      typeof q.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.date)
        ? q.date
        : getETDateStr(new Date());
    const fireTypeParam =
      typeof q.fire_type === 'string' ? q.fire_type : 'both';
    const limitParam = Number.parseInt(
      typeof q.limit === 'string' ? q.limit : '100',
      10,
    );
    const limit = Number.isFinite(limitParam)
      ? Math.min(Math.max(limitParam, 1), 500)
      : 100;

    if (
      fireTypeParam !== 'both' &&
      fireTypeParam !== 'call_lottery' &&
      fireTypeParam !== 'put_lottery'
    ) {
      res
        .status(400)
        .json({ error: 'fire_type must be call_lottery | put_lottery | both' });
      return;
    }

    const sql = getDb();
    const rows = await withDbRetry(async () => {
      if (fireTypeParam === 'both') {
        return (await sql`
          SELECT id, fire_type, fire_time, expiry::text AS expiry,
                 event_strike, trade_strike,
                 spot_at_event, strike_dist,
                 greek_post, greek_delta, greek_lvl_rank, greek_chg_rank,
                 gex_dollars, call_ratio, qqq_net_prem_balance_30m,
                 entry_px, vix, v3_strict_pass, v4_badge,
                 peak_px, peak_pct, peak_time, eod_close_px,
                 realized_r_peak, realized_r_eod, outcome_locked,
                 created_at
          FROM periscope_lottery_fires
          WHERE expiry = ${dateParam}::date
          ORDER BY fire_time DESC
          LIMIT ${limit}
        `) as FireRow[];
      }
      return (await sql`
        SELECT id, fire_type, fire_time, expiry::text AS expiry,
               event_strike, trade_strike,
               spot_at_event, strike_dist,
               greek_post, greek_delta, greek_lvl_rank, greek_chg_rank,
               gex_dollars, call_ratio, qqq_net_prem_balance_30m,
               entry_px, vix, v3_strict_pass, v4_badge,
               peak_px, peak_pct, peak_time, eod_close_px,
               realized_r_peak, realized_r_eod, outcome_locked,
               created_at
        FROM periscope_lottery_fires
        WHERE expiry = ${dateParam}::date
          AND fire_type = ${fireTypeParam}
        ORDER BY fire_time DESC
        LIMIT ${limit}
      `) as FireRow[];
    });

    setCacheHeaders(res, 30, 60);
    res.status(200).json({
      date: dateParam,
      fireType: fireTypeParam,
      count: rows.length,
      fires: rows.map(serializeFire),
    });
  } catch (err) {
    Sentry.captureException(err);
    logger.error({ err }, 'periscope-lottery-feed failed');
    res.status(500).json({ error: 'internal_error' });
  }
}
