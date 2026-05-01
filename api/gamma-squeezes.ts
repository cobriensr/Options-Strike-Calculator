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
import { computePathShape, getLatestSpotsByTicker } from './_lib/path-shape.js';
import {
  evaluatePrecisionPass,
  HHI_PASS_PERCENTILE,
  IV_VOL_CORR_PASS_PERCENTILE,
  quantile,
} from './_lib/precision-stack.js';

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
  /**
   * Path-shape diagnostic — minutes since detection. Live = now − ts;
   * replay (`?at=`) = at − ts. Always ≥ 0.
   */
  freshnessMin: number;
  /**
   * Signed progress from `spotAtDetect` toward `strike` in trade direction.
   * 0 = no movement, 1 = reached strike. Null when current spot is unknown
   * or strike == spotAtDetect.
   */
  progressPct: number | null;
  /**
   * True when freshness > 30 min AND |progressPct| < 0.25. Suppresses
   * lottery-ticket alerts that haven't moved toward target. Computed
   * each request — read-only.
   */
  isStale: boolean;
  /**
   * Cross-strike Herfindahl of notional at fire time. Lower = diffuse
   * neighborhood (winner archetype). Null when fewer than 3 strikes in
   * the ±0.5% band had non-zero notional.
   */
  hhiNeighborhood: number | null;
  /**
   * Pearson correlation of per-minute (Δiv, Δvolume) restricted to ≤11:00
   * CT for this strike. Higher = real demand. Null when fewer than 5
   * minutes of pre-11:00 IV samples or one series had zero variance.
   */
  ivMorningVolCorr: number | null;
  /**
   * True iff (hhiNeighborhood ≤ p30 of day) AND (ivMorningVolCorr ≥ p80
   * of day). Computed per-request from same-day events. ~3-5% of fires
   * pass — high-precision filter, low recall.
   */
  precisionStackPass: boolean;
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
  hhi_neighborhood: NumericFromDb;
  iv_morning_vol_corr: NumericFromDb;
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
    hhiNeighborhood: parseNumOrNull(r.hhi_neighborhood),
    ivMorningVolCorr: parseNumOrNull(r.iv_morning_vol_corr),
    // Filled in by attachPathShape and attachPrecisionPass after rows load.
    freshnessMin: 0,
    progressPct: null,
    isStale: false,
    precisionStackPass: false,
  };
}

/**
 * Compute the precision-stack pass flag per row using same-day percentiles
 * across all queried events. Mirrors the backfill logic but operates on
 * the in-memory result set so the flag tracks day-so-far data during live
 * trading. Mutates rows in place; returns nothing.
 */
function attachPrecisionPass(rowsByTicker: Map<string, GammaSqueezeRow[]>): void {
  // Bucket all rows by trade_date_CT regardless of ticker — the precision
  // signal is universe-wide, not per-ticker.
  const byDate = new Map<string, GammaSqueezeRow[]>();
  for (const rows of rowsByTicker.values()) {
    for (const r of rows) {
      const d = new Date(r.ts);
      if (Number.isNaN(d.getTime())) continue;
      // Convert to CT date by subtracting the UTC offset for America/Chicago
      // at the row's ts. Practical shortcut for DST: use Intl with a fixed
      // formatter — accurate across DST flips.
      const ct = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Chicago',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(d);
      const bucket = byDate.get(ct);
      if (bucket) bucket.push(r);
      else byDate.set(ct, [r]);
    }
  }
  for (const rows of byDate.values()) {
    const hhis = rows
      .map((r) => r.hhiNeighborhood)
      .filter((v): v is number => v != null && Number.isFinite(v));
    const corrs = rows
      .map((r) => r.ivMorningVolCorr)
      .filter((v): v is number => v != null && Number.isFinite(v));
    const hhiP30 = quantile(hhis, HHI_PASS_PERCENTILE);
    const corrP80 = quantile(corrs, IV_VOL_CORR_PASS_PERCENTILE);
    for (const r of rows) {
      r.precisionStackPass = evaluatePrecisionPass(
        r.hhiNeighborhood,
        r.ivMorningVolCorr,
        hhiP30,
        corrP80,
      );
    }
  }
}

async function attachPathShape(
  rowsByTicker: Map<string, GammaSqueezeRow[]>,
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

    const { ticker, limit, at } = parsed.data;
    const sql = getDb();

    // Replay window: when `at` is provided, return squeezes in the 24h
    // window ending at that timestamp. Mirrors the IV anomalies replay
    // shape so the scrubber UX is identical across the two panels.
    const REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;
    const atDate = at ? new Date(at) : null;
    const atFloor = atDate
      ? new Date(atDate.getTime() - REPLAY_WINDOW_MS)
      : null;

    try {
      const requested: Ticker[] = ticker ? [ticker] : [...TICKERS];

      const bundles = await Promise.all(
        requested.map(async (t) => {
          const rows = (
            atDate && atFloor
              ? await sql`
              SELECT id, ticker, strike, side, expiry, ts,
                     spot_at_detect, pct_from_strike, spot_trend_5m,
                     vol_oi_15m, vol_oi_15m_prior, vol_oi_acceleration, vol_oi_total,
                     net_gamma_sign, squeeze_phase, context_snapshot,
                     spot_at_close, reached_strike, max_call_pnl_pct,
                     hhi_neighborhood, iv_morning_vol_corr
              FROM gamma_squeeze_events
              WHERE ticker = ${t}
                AND ts <= ${atDate.toISOString()}
                AND ts >= ${atFloor.toISOString()}
              ORDER BY ts DESC
              LIMIT ${limit}
            `
              : await sql`
              SELECT id, ticker, strike, side, expiry, ts,
                     spot_at_detect, pct_from_strike, spot_trend_5m,
                     vol_oi_15m, vol_oi_15m_prior, vol_oi_acceleration, vol_oi_total,
                     net_gamma_sign, squeeze_phase, context_snapshot,
                     spot_at_close, reached_strike, max_call_pnl_pct,
                     hhi_neighborhood, iv_morning_vol_corr
              FROM gamma_squeeze_events
              WHERE ticker = ${t}
                AND ts >= NOW() - INTERVAL '24 hours'
              ORDER BY ts DESC
              LIMIT ${limit}
            `
          ) as RawSqueezeRow[];
          return { ticker: t, rows: rows.map(mapSqueeze) };
        }),
      );

      const latest = Object.fromEntries(
        TICKERS.map((t) => [t, null]),
      ) as unknown as Record<Ticker, GammaSqueezeRow | null>;
      const history = Object.fromEntries(
        TICKERS.map((t) => [t, [] as GammaSqueezeRow[]]),
      ) as unknown as Record<Ticker, GammaSqueezeRow[]>;

      const rowsByTicker = new Map<string, GammaSqueezeRow[]>();
      for (const { ticker: t, rows } of bundles) {
        history[t] = rows;
        latest[t] = rows[0] ?? null;
        rowsByTicker.set(t, rows);
      }

      // One DB query (lateral-joined), mutates rows in place.
      // Failure here MUST NOT 500: enrichment, not core data.
      try {
        await attachPathShape(rowsByTicker, atDate);
      } catch (err) {
        Sentry.captureException(err);
        logger.warn({ err }, 'gamma-squeezes: path-shape attachment failed');
      }

      // Precision-stack pass flag — derives per-day HHI/IV-vol-corr
      // percentiles from the queried result set and tags each row.
      // Pure in-memory, no DB call. Cannot fail in a way that would 500.
      attachPrecisionPass(rowsByTicker);

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
