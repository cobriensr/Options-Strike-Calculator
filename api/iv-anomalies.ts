/**
 * GET /api/iv-anomalies
 *
 * Owner-gated read endpoint backing the Phase 3 Strike IV Anomaly Detector UI.
 *
 * Owner-gated because per-strike IV (Phase 1) + detection flags (Phase 2) are
 * derived from OPRA-licensed option chain data — same owner-only category as
 * /api/zero-gamma, /api/spot-gex-history, and /api/gex-per-strike.
 *
 * Two modes, selected by the presence of `strike`/`side`/`expiry`:
 *
 *   1. **List mode** (default): `{ latest, history }` per ticker. When the
 *      caller supplies `?ticker=SPX` only that key is populated; when it's
 *      omitted all three (SPX/SPY/QQQ) come back.
 *
 *   2. **Per-strike history mode**: `?ticker=SPX&strike=7135&side=put&expiry=...`
 *      returns the minute-by-minute IV bid/mid/ask series from
 *      `strike_iv_snapshots`. Feeds StrikeIVChart.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from './_lib/db.js';
import { Sentry } from './_lib/sentry.js';
import logger from './_lib/logger.js';
import {
  checkBot,
  isMarketOpen,
  rejectIfNotOwner,
  setCacheHeaders,
} from './_lib/api-helpers.js';
import { ivAnomaliesQuerySchema } from './_lib/validation.js';

const TICKERS = ['SPX', 'SPY', 'QQQ'] as const;
type Ticker = (typeof TICKERS)[number];

export interface IVAnomalyRow {
  id: number;
  ticker: string;
  strike: number;
  side: 'call' | 'put';
  expiry: string;
  spotAtDetect: number;
  ivAtDetect: number;
  skewDelta: number | null;
  zScore: number | null;
  askMidDiv: number | null;
  flagReasons: string[];
  flowPhase: 'early' | 'mid' | 'reactive' | null;
  contextSnapshot: unknown;
  resolutionOutcome: unknown;
  ts: string;
}

export interface StrikeIVSample {
  ts: string;
  ivMid: number | null;
  ivBid: number | null;
  ivAsk: number | null;
  midPrice: number | null;
  spot: number;
}

export interface IVAnomaliesListResponse {
  mode: 'list';
  latest: Record<Ticker, IVAnomalyRow | null>;
  history: Record<Ticker, IVAnomalyRow[]>;
}

export interface IVAnomaliesHistoryResponse {
  mode: 'history';
  ticker: Ticker;
  strike: number;
  side: 'call' | 'put';
  expiry: string;
  samples: StrikeIVSample[];
}

export type IVAnomaliesResponse =
  | IVAnomaliesListResponse
  | IVAnomaliesHistoryResponse;

// ── DB row shapes ────────────────────────────────────────────

type NumericFromDb = string | number | null;

interface RawAnomalyRow {
  id: number | string;
  ticker: string;
  strike: NumericFromDb;
  side: string;
  expiry: string | Date;
  spot_at_detect: NumericFromDb;
  iv_at_detect: NumericFromDb;
  skew_delta: NumericFromDb;
  z_score: NumericFromDb;
  ask_mid_div: NumericFromDb;
  flag_reasons: string[] | null;
  flow_phase: string | null;
  context_snapshot: unknown;
  resolution_outcome: unknown;
  ts: string | Date;
}

interface RawSampleRow {
  ts: string | Date;
  iv_mid: NumericFromDb;
  iv_bid: NumericFromDb;
  iv_ask: NumericFromDb;
  mid_price: NumericFromDb;
  spot: NumericFromDb;
}

// ── Helpers ──────────────────────────────────────────────────

function toIso(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

/**
 * YYYY-MM-DD from a DATE column. Neon returns DATE as a string but we
 * tolerate a Date object too (driver version drift).
 */
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

function parseFlowPhase(
  value: string | null,
): 'early' | 'mid' | 'reactive' | null {
  if (value === 'early' || value === 'mid' || value === 'reactive') {
    return value;
  }
  return null;
}

function mapAnomaly(r: RawAnomalyRow): IVAnomalyRow {
  return {
    id: typeof r.id === 'number' ? r.id : Number(r.id),
    ticker: r.ticker,
    strike: parseNum(r.strike),
    side: parseSide(r.side),
    expiry: toYmd(r.expiry),
    spotAtDetect: parseNum(r.spot_at_detect),
    ivAtDetect: parseNum(r.iv_at_detect),
    skewDelta: parseNumOrNull(r.skew_delta),
    zScore: parseNumOrNull(r.z_score),
    askMidDiv: parseNumOrNull(r.ask_mid_div),
    flagReasons: Array.isArray(r.flag_reasons) ? r.flag_reasons : [],
    flowPhase: parseFlowPhase(r.flow_phase),
    contextSnapshot: r.context_snapshot,
    resolutionOutcome: r.resolution_outcome,
    ts: toIso(r.ts),
  };
}

function mapSample(r: RawSampleRow): StrikeIVSample {
  return {
    ts: toIso(r.ts),
    ivMid: parseNumOrNull(r.iv_mid),
    ivBid: parseNumOrNull(r.iv_bid),
    ivAsk: parseNumOrNull(r.iv_ask),
    midPrice: parseNumOrNull(r.mid_price),
    spot: parseNum(r.spot),
  };
}

// ── Handler ──────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return Sentry.withIsolationScope(async (scope) => {
    scope.setTransactionName('GET /api/iv-anomalies');

    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'GET only' });
    }

    const botCheck = await checkBot(req);
    if (botCheck.isBot) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (rejectIfNotOwner(req, res)) return;

    const parsed = ivAnomaliesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(400).json({
        error: parsed.error.issues[0]?.message ?? 'Invalid query',
      });
    }

    const { ticker, strike, side, expiry, limit } = parsed.data;
    const sql = getDb();

    try {
      if (strike != null && side != null && expiry != null && ticker != null) {
        const rows = (await sql`
          SELECT ts, iv_mid, iv_bid, iv_ask, mid_price, spot
          FROM strike_iv_snapshots
          WHERE ticker = ${ticker}
            AND strike = ${strike}
            AND side   = ${side}
            AND expiry = ${expiry}
          ORDER BY ts DESC
          LIMIT ${limit}
        `) as RawSampleRow[];

        // Return the series in ascending time order — charts iterate left →
        // right, and the DESC + reverse pattern keeps the SQL index-friendly.
        const samples = rows.map(mapSample).reverse();

        const historyResponse: IVAnomaliesHistoryResponse = {
          mode: 'history',
          ticker,
          strike,
          side,
          expiry,
          samples,
        };

        setCacheHeaders(res, isMarketOpen() ? 30 : 300, 60);
        return res.status(200).json(historyResponse);
      }

      // List mode — fetch anomalies for the requested ticker, or all three.
      const requested: Ticker[] = ticker ? [ticker] : [...TICKERS];

      const bundles = await Promise.all(
        requested.map(async (t) => {
          const rows = (await sql`
            SELECT id, ticker, strike, side, expiry,
                   spot_at_detect, iv_at_detect,
                   skew_delta, z_score, ask_mid_div,
                   flag_reasons, flow_phase,
                   context_snapshot, resolution_outcome, ts
            FROM iv_anomalies
            WHERE ticker = ${t}
            ORDER BY ts DESC
            LIMIT ${limit}
          `) as RawAnomalyRow[];
          return { ticker: t, rows: rows.map(mapAnomaly) };
        }),
      );

      // Always emit all three keys so the client never has to guess whether
      // a missing key means "no data" or "not requested". When a specific
      // ticker is requested, the other two keys are null / [].
      const latest: Record<Ticker, IVAnomalyRow | null> = {
        SPX: null,
        SPY: null,
        QQQ: null,
      };
      const history: Record<Ticker, IVAnomalyRow[]> = {
        SPX: [],
        SPY: [],
        QQQ: [],
      };

      for (const { ticker: t, rows } of bundles) {
        history[t] = rows;
        latest[t] = rows[0] ?? null;
      }

      const listResponse: IVAnomaliesListResponse = {
        mode: 'list',
        latest,
        history,
      };

      setCacheHeaders(res, isMarketOpen() ? 30 : 300, 60);
      return res.status(200).json(listResponse);
    } catch (err) {
      Sentry.captureException(err);
      logger.error({ err, ticker, strike }, 'iv-anomalies fetch error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
