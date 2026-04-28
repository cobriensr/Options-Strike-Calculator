/**
 * GET /api/cron/compute-zero-gamma
 *
 * Computes the zero-gamma level for each cross-asset ticker (SPX, NDX, SPY,
 * QQQ) during market hours. Reads the latest per-strike intraday gamma
 * snapshot from `strike_exposures` (written by fetch-strike-exposure on a
 * staggered 5-min cadence), aggregates call + put OI gamma into a signed
 * per-strike dealer gamma profile, and hands it to the pure
 * computeZeroGammaLevel() calculator in api/_lib/zero-gamma.
 *
 * Outputs land in `zero_gamma_levels` (migration 82):
 *   - ticker, spot, zero_gamma (confidence-gated, nullable)
 *   - confidence (raw), net_gamma_at_spot, gamma_curve (JSONB)
 *
 * Per-ticker behavior:
 *   - SPX/SPY/QQQ → primary expiry = today (0DTE).
 *   - NDX → primary expiry = front Mon/Wed/Fri (handled by getPrimaryExpiry).
 *
 * No confidence gating: zero-gamma is a regime indicator (the spot price
 * where dealer net gamma crosses sign), not a trade trigger. The level is
 * stored whenever the calculator can find a sign change in ±3% of spot.
 * `confidence` is recorded alongside for UI styling / filtering.
 *
 * `zero_gamma` is NULL only when:
 *   - the gamma profile has no sign change in the ±3% grid, OR
 *   - the ticker has no fresh strike_exposures snapshot (we log + skip).
 *
 * Cadence: 5-min at +1 offset from fetch-strike-exposure source — ensures
 * the source rows are committed before we read them. Cron line:
 *   4,9,14,19,24,29,34,39,44,49,54,59 13-21 * * 1-5
 *
 * Tickers run sequentially. The total work is 4 × (2 SELECTs + 1 INSERT) =
 * 12 trivial DB queries — sequential is cleaner than parallel and avoids
 * connection-pool pressure on Neon serverless. Per-ticker failures are
 * caught individually so one bad ticker does not block the others.
 *
 * Environment: CRON_SECRET (no UW API key required — purely derivative)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { cronGuard } from '../_lib/api-helpers.js';
import { computeZeroGammaLevel, type GexStrike } from '../_lib/zero-gamma.js';
import {
  ZERO_GAMMA_TICKERS,
  getPrimaryExpiry,
  type ZeroGammaTicker,
} from '../_lib/zero-gamma-tickers.js';

// ── Row shape from strike_exposures ──────────────────────────

interface StrikeExposureRow {
  strike: string | number;
  price: string | number;
  call_gamma_oi: string | number | null;
  put_gamma_oi: string | number | null;
  timestamp: string | Date;
}

interface SnapshotBundle {
  spot: number;
  timestamp: string;
  strikes: GexStrike[];
}

/**
 * Load the most recent per-strike gamma snapshot for the given ticker at
 * its primary expiry.
 *
 * `strike_exposures` holds per-(date, timestamp, ticker, strike, expiry)
 * rows written every 5 minutes. We want a single coherent snapshot: the
 * latest timestamp that has at least one row for (ticker, primary expiry),
 * plus every strike on that timestamp. Returns null if no rows exist.
 */
async function loadLatestSnapshot(
  sql: ReturnType<typeof getDb>,
  ticker: ZeroGammaTicker,
  today: string,
  expiry: string,
): Promise<SnapshotBundle | null> {
  const latestTsRows = (await sql`
    SELECT MAX(timestamp) AS latest_ts
    FROM strike_exposures
    WHERE date = ${today}
      AND ticker = ${ticker}
      AND expiry = ${expiry}
  `) as Array<{ latest_ts: string | Date | null }>;

  const latestTsRaw = latestTsRows[0]?.latest_ts ?? null;
  if (latestTsRaw == null) return null;

  const latestTs =
    latestTsRaw instanceof Date
      ? latestTsRaw.toISOString()
      : new Date(latestTsRaw).toISOString();

  const rows = (await sql`
    SELECT strike, price, call_gamma_oi, put_gamma_oi, timestamp
    FROM strike_exposures
    WHERE date = ${today}
      AND ticker = ${ticker}
      AND expiry = ${expiry}
      AND timestamp = ${latestTs}
    ORDER BY strike ASC
  `) as StrikeExposureRow[];

  if (rows.length === 0) return null;

  const spot = Number(rows[0]!.price);
  if (!Number.isFinite(spot) || spot <= 0) return null;

  // Combine call + put OI gamma into signed dealer gamma per strike.
  // UW already publishes signed values on these columns — sum per strike.
  // Strikes missing both values are skipped.
  const strikes: GexStrike[] = [];
  for (const r of rows) {
    const strike = Number(r.strike);
    if (!Number.isFinite(strike)) continue;
    const callGamma = r.call_gamma_oi == null ? 0 : Number(r.call_gamma_oi);
    const putGamma = r.put_gamma_oi == null ? 0 : Number(r.put_gamma_oi);
    if (!Number.isFinite(callGamma) && !Number.isFinite(putGamma)) continue;
    const gamma =
      (Number.isFinite(callGamma) ? callGamma : 0) +
      (Number.isFinite(putGamma) ? putGamma : 0);
    if (gamma === 0) continue;
    strikes.push({ strike, gamma });
  }

  if (strikes.length === 0) return null;

  return { spot, timestamp: latestTs, strikes };
}

/**
 * Derive dealer net gamma at the actual spot from the calculator's curve.
 *
 * The calculator samples 30 candidate spots across ±3% of `spot`, so the
 * true spot usually falls between two adjacent grid points. We pick the
 * closest sample by absolute spot delta. The grid step is ~0.2% of spot
 * which is well below the regime-detection noise floor — small enough
 * that a closest-point read is indistinguishable from a full re-kernel
 * for monitoring purposes.
 */
function netGammaAtSpot(
  curve: Array<{ spot: number; netGamma: number }>,
  spot: number,
): number | null {
  if (curve.length === 0) return null;
  let best = curve[0]!;
  let bestDist = Math.abs(best.spot - spot);
  for (let i = 1; i < curve.length; i += 1) {
    const pt = curve[i]!;
    const dist = Math.abs(pt.spot - spot);
    if (dist < bestDist) {
      best = pt;
      bestDist = dist;
    }
  }
  return best.netGamma;
}

interface TickerOutcome {
  stored: boolean;
  reason?: string;
  spot?: number;
  zeroGamma?: number | null;
  confidence?: number;
}

/**
 * Process one ticker end-to-end: load snapshot → compute → insert.
 * Throws on DB errors (caught by the caller's per-ticker try/catch so one
 * bad ticker does not abort the rest of the loop).
 */
async function processTicker(
  sql: ReturnType<typeof getDb>,
  ticker: ZeroGammaTicker,
  today: string,
): Promise<TickerOutcome> {
  const expiry = getPrimaryExpiry(ticker, today);
  const snapshot = await loadLatestSnapshot(sql, ticker, today, expiry);

  if (snapshot == null) {
    logger.info(
      { ticker, today, expiry },
      'compute-zero-gamma: no strike_exposures snapshot — skipping ticker',
    );
    return { stored: false, reason: 'No strike_exposures snapshot' };
  }

  const result = computeZeroGammaLevel(snapshot.strikes, snapshot.spot);

  // No confidence gate: zero-gamma is a regime indicator, not a trade
  // trigger — we want to see the level whenever the calculator can find
  // a sign change in ±3% of spot. `confidence` is stored alongside so
  // consumers can dim/style low-confidence reads in the UI.
  const zeroGamma = result.level;

  const netGamma = netGammaAtSpot(result.curve, snapshot.spot);
  const gammaCurveJson = JSON.stringify(result.curve);

  await sql`
    INSERT INTO zero_gamma_levels (
      ticker, spot, zero_gamma, confidence,
      net_gamma_at_spot, gamma_curve
    )
    VALUES (
      ${ticker}, ${snapshot.spot}, ${zeroGamma}, ${result.confidence},
      ${netGamma}, ${gammaCurveJson}::jsonb
    )
    ON CONFLICT (ticker, ts) DO NOTHING
  `;

  logger.info(
    {
      ticker,
      spot: snapshot.spot,
      zeroGamma,
      rawLevel: result.level,
      confidence: result.confidence,
      netGammaAtSpot: netGamma,
      strikesUsed: snapshot.strikes.length,
      snapshotTs: snapshot.timestamp,
    },
    'computed zero-gamma',
  );

  return {
    stored: true,
    spot: snapshot.spot,
    zeroGamma,
    confidence: result.confidence,
  };
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res, { requireApiKey: false });
  if (!guard) return;
  const { today } = guard;

  const startTime = Date.now();
  const sql = getDb();

  const perTicker: Record<
    string,
    TickerOutcome | { stored: false; error: string }
  > = {};

  for (const ticker of ZERO_GAMMA_TICKERS) {
    try {
      perTicker[ticker] = await processTicker(sql, ticker, today);
    } catch (err) {
      Sentry.setTag('cron.job', 'compute-zero-gamma');
      Sentry.setTag('ticker', ticker);
      Sentry.captureException(err);
      logger.error({ err, ticker }, 'compute-zero-gamma: per-ticker failure');
      perTicker[ticker] = { stored: false, error: String(err) };
    }
  }

  return res.status(200).json({
    job: 'compute-zero-gamma',
    perTicker,
    durationMs: Date.now() - startTime,
  });
}
