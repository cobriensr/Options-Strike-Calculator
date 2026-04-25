/**
 * GET /api/strike-trade-volume
 *
 * Owner-gated read endpoint backing the bid-side-surge exit signal in
 * `useIVAnomalies` (Phase 3 of the tape-side spec).
 *
 * Two modes:
 *   1. **Bulk mode** (default): `?ticker=SPY&since=<ISO>` → returns all
 *      (strike, side, ts) tape rows for the ticker since `since`. Used
 *      by the hook to fetch tape data for all currently-active compound
 *      keys in a single query rather than N parallel queries.
 *
 *   2. **Single-key mode**: `?ticker=SPY&strike=705&side=put&since=<ISO>` →
 *      returns one strike's time series since `since`. Used for drill-down
 *      views.
 *
 * Note: `strike_trade_volume` aggregates across expiries (UW's
 * flow-per-strike-intraday endpoint shape) — there is no `expiry`
 * filter parameter.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from './_lib/db.js';
import { Sentry } from './_lib/sentry.js';
import logger from './_lib/logger.js';
import {
  checkBot,
  rejectIfNotOwner,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { strikeTradeVolumeQuerySchema } from './_lib/validation.js';
import type { StrikeIVTicker } from './_lib/constants.js';

// ── Public types ─────────────────────────────────────────────

export interface StrikeTradeVolumeSample {
  ts: string;
  bidSideVol: number;
  askSideVol: number;
  midVol: number;
  totalVol: number;
}

export interface StrikeTradeVolumeSeries {
  ticker: StrikeIVTicker;
  strike: number;
  side: 'call' | 'put';
  data: StrikeTradeVolumeSample[];
}

export interface StrikeTradeVolumeResponse {
  series: StrikeTradeVolumeSeries[];
}

// ── DB row shape ─────────────────────────────────────────────

type NumericFromDb = string | number | null;

interface RawVolumeRow {
  ticker: string;
  strike: NumericFromDb;
  side: string;
  ts: string | Date;
  bid_side_vol: NumericFromDb;
  ask_side_vol: NumericFromDb;
  mid_vol: NumericFromDb;
  total_vol: NumericFromDb;
}

function toIso(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function parseNum(value: NumericFromDb): number {
  if (value == null) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function parseSide(value: string): 'call' | 'put' {
  return value === 'call' ? 'call' : 'put';
}

// ── Handler ──────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTag('endpoint', '/api/strike-trade-volume');

    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'GET only' });
    }

    const botCheck = await checkBot(req);
    if (botCheck.isBot) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (rejectIfNotOwner(req, res)) return;

    const parseResult = strikeTradeVolumeQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      return res
        .status(400)
        .json({ error: 'Invalid query', issues: parseResult.error.issues });
    }
    const q = parseResult.data;

    try {
      const sql = getDb();
      const rows = (q.strike != null && q.side != null
        ? await sql`
            SELECT ticker, strike, side, ts,
                   bid_side_vol, ask_side_vol, mid_vol, total_vol
            FROM strike_trade_volume
            WHERE ticker = ${q.ticker}
              AND strike = ${q.strike}
              AND side = ${q.side}
              AND ts >= ${q.since}
            ORDER BY ts ASC
          `
        : await sql`
            SELECT ticker, strike, side, ts,
                   bid_side_vol, ask_side_vol, mid_vol, total_vol
            FROM strike_trade_volume
            WHERE ticker = ${q.ticker}
              AND ts >= ${q.since}
            ORDER BY strike ASC, side ASC, ts ASC
          `) as RawVolumeRow[];

      // Group by (strike, side) → series
      const byKey = new Map<string, StrikeTradeVolumeSeries>();
      for (const r of rows) {
        const strike = parseNum(r.strike);
        const side = parseSide(r.side);
        const key = `${strike}:${side}`;
        let series = byKey.get(key);
        if (!series) {
          series = {
            ticker: q.ticker,
            strike,
            side,
            data: [],
          };
          byKey.set(key, series);
        }
        series.data.push({
          ts: toIso(r.ts),
          bidSideVol: parseNum(r.bid_side_vol),
          askSideVol: parseNum(r.ask_side_vol),
          midVol: parseNum(r.mid_vol),
          totalVol: parseNum(r.total_vol),
        });
      }

      const response: StrikeTradeVolumeResponse = {
        series: [...byKey.values()],
      };

      setCacheHeaders(res, 30);
      return res.status(200).json(response);
    } catch (err) {
      logger.error({ err }, 'strike-trade-volume failed');
      Sentry.captureException(err);
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
