/**
 * GET /api/gamma-squeezes
 *
 * Owner-or-guest read endpoint backing the Gamma Squeeze Feed UI.
 * Same auth tier as /api/iv-anomalies.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from './_lib/db.js';
import { Sentry, metrics } from './_lib/sentry.js';
import logger from './_lib/logger.js';
import {
  guardOwnerOrGuestEndpoint,
  isMarketOpen,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { gammaSqueezesQuerySchema } from './_lib/validation.js';
import { STRIKE_IV_TICKERS, type StrikeIVTicker } from './_lib/constants.js';

const TICKERS = STRIKE_IV_TICKERS;
type Ticker = StrikeIVTicker;

export interface GammaSqueezeRow {
  id: number;
  ticker: string;
  strike: number;
  side: 'call' | 'put';
  expiry: string;
  ts: string;
  spotAtDetect: number;
  pctFromStrike: number;
  spotTrend5m: number;
  volOi15m: number;
  volOi15mPrior: number;
  volOiAcceleration: number;
  volOiTotal: number;
  netGammaSign: 'short' | 'long' | 'unknown';
  squeezePhase: 'forming' | 'active' | 'exhausted';
  contextSnapshot: unknown;
  reachedStrike: boolean | null;
  spotAtClose: number | null;
  maxCallPnlPct: number | null;
}

export interface GammaSqueezesResponse {
  mode: 'list';
  latest: Record<Ticker, GammaSqueezeRow | null>;
  history: Record<Ticker, GammaSqueezeRow[]>;
}

type NumericFromDb = string | number | null;

interface RawSqueezeRow {
  id: number | string;
  ticker: string;
  strike: NumericFromDb;
  side: string;
  expiry: string | Date;
  ts: string | Date;
  spot_at_detect: NumericFromDb;
  pct_from_strike: NumericFromDb;
  spot_trend_5m: NumericFromDb;
  vol_oi_15m: NumericFromDb;
  vol_oi_15m_prior: NumericFromDb;
  vol_oi_acceleration: NumericFromDb;
  vol_oi_total: NumericFromDb;
  net_gamma_sign: string;
  squeeze_phase: string;
  context_snapshot: unknown;
  spot_at_close: NumericFromDb;
  reached_strike: boolean | null;
  max_call_pnl_pct: NumericFromDb;
}

function toIso(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function toYmd(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const match = /^\d{4}-\d{2}-\d{2}/.exec(value);
  return match ? match[0] : String(value);
}

function parseNumOrNull(value: NumericFromDb): number | null {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseNum(value: NumericFromDb): number {
  const n = parseNumOrNull(value);
  return n ?? Number.NaN;
}

function parseSide(value: string): 'call' | 'put' {
  return value === 'call' ? 'call' : 'put';
}

function parseNetGammaSign(value: string): 'short' | 'long' | 'unknown' {
  if (value === 'short' || value === 'long') return value;
  return 'unknown';
}

function parsePhase(value: string): 'forming' | 'active' | 'exhausted' {
  if (value === 'active' || value === 'exhausted') return value;
  return 'forming';
}

function mapSqueeze(r: RawSqueezeRow): GammaSqueezeRow {
  return {
    id: typeof r.id === 'number' ? r.id : Number(r.id),
    ticker: r.ticker,
    strike: parseNum(r.strike),
    side: parseSide(r.side),
    expiry: toYmd(r.expiry),
    ts: toIso(r.ts),
    spotAtDetect: parseNum(r.spot_at_detect),
    pctFromStrike: parseNum(r.pct_from_strike),
    spotTrend5m: parseNum(r.spot_trend_5m),
    volOi15m: parseNum(r.vol_oi_15m),
    volOi15mPrior: parseNum(r.vol_oi_15m_prior),
    volOiAcceleration: parseNum(r.vol_oi_acceleration),
    volOiTotal: parseNum(r.vol_oi_total),
    netGammaSign: parseNetGammaSign(r.net_gamma_sign),
    squeezePhase: parsePhase(r.squeeze_phase),
    contextSnapshot: r.context_snapshot,
    spotAtClose: parseNumOrNull(r.spot_at_close),
    reachedStrike: r.reached_strike,
    maxCallPnlPct: parseNumOrNull(r.max_call_pnl_pct),
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/gamma-squeezes');
    const done = metrics.request('/api/gamma-squeezes');

    if (req.method !== 'GET') {
      done({ status: 405 });
      return res.status(405).json({ error: 'GET only' });
    }

    if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

    const parsed = gammaSqueezesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.setHeader('Cache-Control', 'no-store');
      done({ status: 400 });
      return res.status(400).json({
        error: parsed.error.issues[0]?.message ?? 'Invalid query',
      });
    }

    const { ticker, limit } = parsed.data;
    const sql = getDb();

    try {
      const requested: Ticker[] = ticker ? [ticker] : [...TICKERS];

      const bundles = await Promise.all(
        requested.map(async (t) => {
          const rows = (await sql`
            SELECT id, ticker, strike, side, expiry, ts,
                   spot_at_detect, pct_from_strike, spot_trend_5m,
                   vol_oi_15m, vol_oi_15m_prior, vol_oi_acceleration, vol_oi_total,
                   net_gamma_sign, squeeze_phase, context_snapshot,
                   spot_at_close, reached_strike, max_call_pnl_pct
            FROM gamma_squeeze_events
            WHERE ticker = ${t}
              AND ts >= NOW() - INTERVAL '24 hours'
            ORDER BY ts DESC
            LIMIT ${limit}
          `) as RawSqueezeRow[];
          return { ticker: t, rows: rows.map(mapSqueeze) };
        }),
      );

      const latest = Object.fromEntries(
        TICKERS.map((t) => [t, null]),
      ) as unknown as Record<Ticker, GammaSqueezeRow | null>;
      const history = Object.fromEntries(
        TICKERS.map((t) => [t, [] as GammaSqueezeRow[]]),
      ) as unknown as Record<Ticker, GammaSqueezeRow[]>;

      for (const { ticker: t, rows } of bundles) {
        history[t] = rows;
        latest[t] = rows[0] ?? null;
      }

      const response: GammaSqueezesResponse = { mode: 'list', latest, history };

      setCacheHeaders(res, isMarketOpen() ? 30 : 300, 60);
      done({ status: 200 });
      return res.status(200).json(response);
    } catch (err) {
      done({ status: 500 });
      Sentry.captureException(err);
      logger.error({ err, ticker }, 'gamma-squeezes fetch error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
