/**
 * GET /api/lottery-contract-tape
 *
 * Owner-or-guest read endpoint backing the per-fire contract panel
 * inside LotteryFinderRow. Returns per-minute aggregated bid/ask/mid
 * volume bars + average price for one OCC option chain on one
 * trading day, computed from `ws_option_trades` (the daemon's raw
 * per-tick OPRA stream).
 *
 * Mirror of UW's contract-page left panel: bid/ask vol stacked bars
 * with the avg price as an overlay line, anchored to a fire-time
 * vertical marker the chart layer renders client-side.
 *
 * Query params: ?chain= ?date= ?from= ?to=
 * Validated by `lotteryContractTapeQuerySchema` in api/_lib/validation.ts.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from './_lib/db.js';
import { Sentry } from './_lib/sentry.js';
import logger from './_lib/logger.js';
import {
  guardOwnerOrGuestEndpoint,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { lotteryContractTapeQuerySchema } from './_lib/validation.js';
import { getETDateStr } from '../src/utils/timezone.js';
import { ctSessionBounds } from '../src/components/LotteryFinder/ct-window.js';

type DbNumeric = string | number;
type DbTimestamp = string | Date;

interface TapeRow {
  bucket: DbTimestamp;
  ask_vol: number | string;
  bid_vol: number | string;
  mid_vol: number | string;
  no_side_vol: number | string;
  total_vol: number | string;
  // Volume-weighted average price across the minute.
  avg_price: DbNumeric | null;
  high_price: DbNumeric | null;
  low_price: DbNumeric | null;
}

const toIso = (v: DbTimestamp): string =>
  typeof v === 'string' ? v : v.toISOString();

const num = (v: DbNumeric | null): number | null =>
  v == null ? null : Number(v);

/**
 * Convert HH:MM CT to a UTC ISO timestamp on the given date. Same
 * helper used by net-flow-history so the from/to params line up
 * across both endpoints when the chart layer fetches them in parallel.
 */
function ctHmToUtc(date: string, hm: string): string {
  const [hh, mm] = hm.split(':').map((n) => Number(n));
  const sessionMinUtc = Date.parse(ctSessionBounds(date).min);
  const targetMinutes = (hh ?? 0) * 60 + (mm ?? 0);
  const sessionStartMinutes = 8 * 60 + 30;
  const deltaMin = targetMinutes - sessionStartMinutes;
  return new Date(sessionMinUtc + deltaMin * 60_000).toISOString();
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  const guarded = await guardOwnerOrGuestEndpoint(req, res, () => undefined);
  if (guarded) return;

  try {
    const parsed = lotteryContractTapeQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid query',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
      return;
    }
    const { chain, date, from, to } = parsed.data;
    const targetDate = date ?? getETDateStr(new Date());

    const session = ctSessionBounds(targetDate);
    const fromTs = from ? ctHmToUtc(targetDate, from) : session.min;
    const toTs = to ? ctHmToUtc(targetDate, to) : session.max;

    const db = getDb();
    // Per-minute aggregation. Bid/ask/mid stacks come from the OPRA
    // side classification on each print; volume-weighted price gives
    // the line. Filter `canceled = FALSE` to drop wipe-outs.
    const rows = (await db`
      SELECT
        date_trunc('minute', executed_at) AS bucket,
        SUM(CASE WHEN side = 'ask' THEN size ELSE 0 END) AS ask_vol,
        SUM(CASE WHEN side = 'bid' THEN size ELSE 0 END) AS bid_vol,
        SUM(CASE WHEN side = 'mid' THEN size ELSE 0 END) AS mid_vol,
        SUM(CASE WHEN side = 'no_side' THEN size ELSE 0 END) AS no_side_vol,
        SUM(size) AS total_vol,
        SUM(price * size) / NULLIF(SUM(size), 0) AS avg_price,
        MAX(price) AS high_price,
        MIN(price) AS low_price
      FROM ws_option_trades
      WHERE option_chain = ${chain}
        AND canceled = FALSE
        AND executed_at >= ${fromTs}::timestamptz
        AND executed_at <= ${toTs}::timestamptz
      GROUP BY bucket
      ORDER BY bucket ASC
    `) as TapeRow[];

    const series = rows.map((r) => ({
      ts: toIso(r.bucket),
      askVol: Number(r.ask_vol),
      bidVol: Number(r.bid_vol),
      midVol: Number(r.mid_vol),
      noSideVol: Number(r.no_side_vol),
      totalVol: Number(r.total_vol),
      avgPrice: num(r.avg_price),
      highPrice: num(r.high_price),
      lowPrice: num(r.low_price),
    }));

    // 30s CDN cache — chart fetches are heavy; brief reuse is cheap.
    setCacheHeaders(res, 30, 30);
    res.status(200).json({
      chain,
      date: targetDate,
      from: fromTs,
      to: toTs,
      count: series.length,
      series,
    });
  } catch (err) {
    Sentry.captureException(err);
    logger.error({ err }, 'lottery-contract-tape error');
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
