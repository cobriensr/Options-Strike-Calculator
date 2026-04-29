/**
 * GET /api/iv-anomalies
 *
 * Owner-or-guest read endpoint backing the Phase 3 Strike IV Anomaly Detector UI.
 *
 * Owner-or-guest because per-strike IV (Phase 1) + detection flags (Phase 2) are
 * derived from OPRA-licensed option chain data — same owner-only category as
 * /api/zero-gamma, /api/spot-gex-history, and /api/gex-per-strike.
 *
 * Two modes, selected by the presence of `strike`/`side`/`expiry`:
 *
 *   1. **List mode** (default): `{ latest, history }` per ticker. When the
 *      caller supplies `?ticker=SPX` only that key is populated; when it's
 *      omitted every ticker in STRIKE_IV_TICKERS comes back.
 *
 *   2. **Per-strike history mode**: `?ticker=SPX&strike=7135&side=put&expiry=...`
 *      returns the minute-by-minute IV bid/mid/ask series from
 *      `strike_iv_snapshots`. Feeds StrikeIVChart.
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
import { ivAnomaliesQuerySchema } from './_lib/validation.js';
import { STRIKE_IV_TICKERS, type StrikeIVTicker } from './_lib/constants.js';
import { computePathShape, getLatestSpotsByTicker } from './_lib/path-shape.js';

const TICKERS = STRIKE_IV_TICKERS;
type Ticker = StrikeIVTicker;

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
  /** Intraday volume / start-of-day OI at detection (primary gate). */
  volOiRatio: number | null;
  /**
   * `max(askPct, bidPct)` at detection — fraction of cumulative tape
   * volume on the dominant side (0.5 = balanced, 1.0 = fully one-sided).
   * On post-migration-95 rows this comes from real bid/ask volume; on
   * pre-migration-95 rows it's the legacy IV-spread proxy.
   */
  sideSkew: number | null;
  /**
   * Which side dominated cumulative tape volume at detection. Production
   * rows are always 'ask' or 'bid' (the gate filters 'mixed' before insert);
   * 'mixed' / null only appear on legacy rows pre-migration 86.
   */
  sideDominant: 'ask' | 'bid' | 'mixed' | null;
  /**
   * Fraction of cumulative tape volume that printed at the bid (0..1).
   * Null on legacy rows pre-migration 95 (real-tape replaced IV-spread proxy).
   */
  bidPct: number | null;
  /** Fraction at the ask (0..1). See `bidPct`. */
  askPct: number | null;
  /** Fraction in the middle / no side determined (0..1). See `bidPct`. */
  midPct: number | null;
  /** Total tape volume on this strike today up to detection ts. */
  totalVolAtDetect: number | null;
  flagReasons: string[];
  flowPhase: 'early' | 'mid' | 'reactive' | null;
  contextSnapshot: unknown;
  resolutionOutcome: unknown;
  ts: string;
  /**
   * Path-shape diagnostic — minutes since detection. Live-mode = now − ts;
   * replay mode (`?at=`) = at − ts. Always ≥ 0.
   */
  freshnessMin: number;
  /**
   * Signed progress from `spotAtDetect` toward `strike` in trade direction
   * (calls: positive when underlying rises; puts: positive when underlying
   * falls). 0 = no movement, 1 = reached strike. Null when current spot
   * is unknown or strike == spotAtDetect.
   */
  progressPct: number | null;
  /**
   * True when freshness > 30 min AND |progressPct| < 0.25. Per the
   * 2026-04-29 outlier study, slow-ITM wins round-trip 56% of the time —
   * UI should de-emphasize stale alerts. Read-only flag, computed each
   * request.
   */
  isStale: boolean;
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
  vol_oi_ratio: NumericFromDb;
  side_skew: NumericFromDb;
  side_dominant: string | null;
  bid_pct: NumericFromDb;
  ask_pct: NumericFromDb;
  mid_pct: NumericFromDb;
  total_vol_at_detect: NumericFromDb;
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

function parseSideDominant(
  value: string | null,
): 'ask' | 'bid' | 'mixed' | null {
  if (value === 'ask' || value === 'bid' || value === 'mixed') {
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
    volOiRatio: parseNumOrNull(r.vol_oi_ratio),
    sideSkew: parseNumOrNull(r.side_skew),
    sideDominant: parseSideDominant(r.side_dominant),
    bidPct: parseNumOrNull(r.bid_pct),
    askPct: parseNumOrNull(r.ask_pct),
    midPct: parseNumOrNull(r.mid_pct),
    totalVolAtDetect: parseNumOrNull(r.total_vol_at_detect),
    flagReasons: Array.isArray(r.flag_reasons) ? r.flag_reasons : [],
    flowPhase: parseFlowPhase(r.flow_phase),
    contextSnapshot: r.context_snapshot,
    resolutionOutcome: r.resolution_outcome,
    ts: toIso(r.ts),
    // Path-shape fields are filled in by attachPathShape after rows are loaded.
    freshnessMin: 0,
    progressPct: null,
    isStale: false,
  };
}

/**
 * Mutate `rows` in place to fill `freshnessMin`, `progressPct`, `isStale`.
 * One DB query for the whole set (lateral-join in path-shape lib) regardless
 * of how many rows came back.
 */
async function attachPathShape(
  rowsByTicker: Map<string, IVAnomalyRow[]>,
  at: Date | null,
): Promise<void> {
  const tickers = [...rowsByTicker.keys()].filter(
    (t) => (rowsByTicker.get(t)?.length ?? 0) > 0,
  );
  if (tickers.length === 0) return;

  const spots = await getLatestSpotsByTicker(tickers, at);
  const nowMs = at ? at.getTime() : Date.now();

  for (const [ticker, rows] of rowsByTicker) {
    const currentSpot = spots.get(ticker) ?? null;
    for (const r of rows) {
      const tsMs = Date.parse(r.ts);
      if (!Number.isFinite(tsMs)) continue;
      const ps = computePathShape(
        tsMs,
        r.spotAtDetect,
        r.strike,
        currentSpot,
        nowMs,
      );
      r.freshnessMin = ps.freshnessMin;
      r.progressPct = ps.progressPct;
      r.isStale = ps.isStale;
    }
  }
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
    const done = metrics.request('/api/iv-anomalies');

    if (req.method !== 'GET') {
      done({ status: 405 });
      return res.status(405).json({ error: 'GET only' });
    }

    if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

    const parsed = ivAnomaliesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.setHeader('Cache-Control', 'no-store');
      done({ status: 400 });
      return res.status(400).json({
        error: parsed.error.issues[0]?.message ?? 'Invalid query',
      });
    }

    const { ticker, strike, side, expiry, limit, at } = parsed.data;
    const sql = getDb();
    // Replay window: when `at` is provided, look back 24h. That's wide
    // enough that any compound key whose silence eviction (default
    // 15-min) hadn't expired at `at` still has at least one firing in
    // the window for the hook's reconcile to rebuild from.
    const REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;
    const atDate = at ? new Date(at) : null;
    const atFloor = atDate
      ? new Date(atDate.getTime() - REPLAY_WINDOW_MS)
      : null;

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
        done({ status: 200 });
        return res.status(200).json(historyResponse);
      }

      // List mode — fetch anomalies for the requested ticker, or all three.
      const requested: Ticker[] = ticker ? [ticker] : [...TICKERS];

      const bundles = await Promise.all(
        requested.map(async (t) => {
          const rows = (
            atDate && atFloor
              ? await sql`
              SELECT id, ticker, strike, side, expiry,
                     spot_at_detect, iv_at_detect,
                     skew_delta, z_score, ask_mid_div, vol_oi_ratio,
                     side_skew, side_dominant,
                     bid_pct, ask_pct, mid_pct, total_vol_at_detect,
                     flag_reasons, flow_phase,
                     context_snapshot, resolution_outcome, ts
              FROM iv_anomalies
              WHERE ticker = ${t}
                AND ts <= ${atDate.toISOString()}
                AND ts >= ${atFloor.toISOString()}
              ORDER BY ts DESC
              LIMIT ${limit}
            `
              : await sql`
              SELECT id, ticker, strike, side, expiry,
                     spot_at_detect, iv_at_detect,
                     skew_delta, z_score, ask_mid_div, vol_oi_ratio,
                     side_skew, side_dominant,
                     bid_pct, ask_pct, mid_pct, total_vol_at_detect,
                     flag_reasons, flow_phase,
                     context_snapshot, resolution_outcome, ts
              FROM iv_anomalies
              WHERE ticker = ${t}
              ORDER BY ts DESC
              LIMIT ${limit}
            `
          ) as RawAnomalyRow[];
          return { ticker: t, rows: rows.map(mapAnomaly) };
        }),
      );

      // Always emit every ticker key so the client never has to guess
      // whether a missing key means "no data" or "not requested". When a
      // specific ticker is requested, the other keys stay null / [].
      const latest = Object.fromEntries(
        TICKERS.map((t) => [t, null]),
      ) as unknown as Record<Ticker, IVAnomalyRow | null>;
      const history = Object.fromEntries(
        TICKERS.map((t) => [t, [] as IVAnomalyRow[]]),
      ) as unknown as Record<Ticker, IVAnomalyRow[]>;

      const rowsByTicker = new Map<string, IVAnomalyRow[]>();
      for (const { ticker: t, rows } of bundles) {
        history[t] = rows;
        latest[t] = rows[0] ?? null;
        rowsByTicker.set(t, rows);
      }

      // Attach freshnessMin / progressPct / isStale on every row in place.
      // One DB query for the whole batch — see api/_lib/path-shape.ts.
      // Failure here MUST NOT 500 the endpoint: callers depend on the alert
      // list itself; path-shape is enrichment. Log and ship with defaults.
      try {
        await attachPathShape(rowsByTicker, atDate);
      } catch (err) {
        Sentry.captureException(err);
        logger.warn({ err }, 'iv-anomalies: path-shape attachment failed');
      }

      const listResponse: IVAnomaliesListResponse = {
        mode: 'list',
        latest,
        history,
      };

      // Replay (?at= in the past) is immutable — historical rows don't
      // change — so cache aggressively. Live mode keeps the existing
      // 30s/300s split.
      const replayCache = atDate && atDate.getTime() < Date.now() - 60_000;
      setCacheHeaders(res, replayCache ? 600 : isMarketOpen() ? 30 : 300, 60);
      done({ status: 200 });
      return res.status(200).json(listResponse);
    } catch (err) {
      done({ status: 500 });
      Sentry.captureException(err);
      logger.error({ err, ticker, strike }, 'iv-anomalies fetch error');
      return res.status(500).json({ error: 'Internal error' });
    }
  });
}
