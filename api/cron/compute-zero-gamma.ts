/**
 * GET /api/cron/compute-zero-gamma
 *
 * Computes the zero-gamma level for each cross-asset ticker (SPX, SPY, QQQ)
 * during market hours. Reads the latest per-strike intraday gamma
 * snapshot from `strike_exposures` (written by fetch-strike-exposure on a
 * staggered 5-min cadence), aggregates call + put OI gamma into a signed
 * per-strike dealer gamma profile, and hands it to the pure
 * computeZeroGammaLevel() calculator in api/_lib/zero-gamma.
 *
 * NDX was dropped 2026-05-16; see `zero-gamma-tickers.ts` for the full
 * rationale (UW NDX monthlies + front-month roll → empty snapshots).
 *
 * Outputs land in `zero_gamma_levels` (migration 82):
 *   - ticker, spot, zero_gamma (confidence-gated, nullable)
 *   - confidence (raw), net_gamma_at_spot, gamma_curve (JSONB)
 *
 * All three tickers use primary expiry = today (0DTE).
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
 * Tickers run sequentially. The total work is 3 × (2 SELECTs + 1 INSERT) =
 * 9 trivial DB queries — sequential is cleaner than parallel and avoids
 * connection-pool pressure on Neon serverless. Per-ticker failures are
 * caught individually so one bad ticker does not block the others.
 *
 * Environment: CRON_SECRET (no UW API key required — purely derivative)
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import {
  withCronInstrumentation,
  deriveCronStatus,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import { computeZeroGammaLevel, type GexStrike } from '../_lib/zero-gamma.js';
import {
  ZERO_GAMMA_TICKERS,
  getPrimaryExpiry,
  type ZeroGammaTicker,
} from '../_lib/zero-gamma-tickers.js';

// ── Row shape from strike_exposures ──────────────────────────

type RawNumeric = string | number | null;

interface StrikeExposureRow {
  strike: string | number;
  price: string | number;
  call_gamma_oi: RawNumeric;
  put_gamma_oi: RawNumeric;
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
  const latestTsRows = (await withDbRetry(
    () => sql`
      SELECT MAX(timestamp) AS latest_ts
      FROM strike_exposures
      WHERE date = ${today}
        AND ticker = ${ticker}
        AND expiry = ${expiry}
    `,
    2,
    10_000,
  )) as Array<{ latest_ts: string | Date | null }>;

  const latestTsRaw = latestTsRows[0]?.latest_ts ?? null;
  if (latestTsRaw == null) return null;

  const latestTs =
    latestTsRaw instanceof Date
      ? latestTsRaw.toISOString()
      : new Date(latestTsRaw).toISOString();

  const rows = (await withDbRetry(
    () => sql`
      SELECT strike, price, call_gamma_oi, put_gamma_oi, timestamp
      FROM strike_exposures
      WHERE date = ${today}
        AND ticker = ${ticker}
        AND expiry = ${expiry}
        AND timestamp = ${latestTs}
      ORDER BY strike ASC
    `,
    2,
    10_000,
  )) as StrikeExposureRow[];

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

  // Sign-flip detection: read the previous row's net γ before inserting.
  // When the sign changes between successive cron ticks, dealer-gamma
  // regime flipped (long-γ ↔ short-γ at spot) — a load-bearing event for
  // post-mortem context on trades that misfire around the transition.
  // We log + breadcrumb here rather than alert because the flip is
  // expected behavior, just one we want to be able to grep for.
  const prevRows = (await withDbRetry(
    () => sql`
      SELECT net_gamma_at_spot::numeric AS net_gamma_at_spot
      FROM zero_gamma_levels
      WHERE ticker = ${ticker}
      ORDER BY ts DESC
      LIMIT 1
    `,
    2,
    10_000,
  )) as { net_gamma_at_spot: string | number | null }[];
  const prevNetGammaRaw = prevRows[0]?.net_gamma_at_spot ?? null;
  const prevNetGamma =
    prevNetGammaRaw == null
      ? null
      : typeof prevNetGammaRaw === 'number'
        ? prevNetGammaRaw
        : Number.parseFloat(prevNetGammaRaw);
  const prev =
    prevNetGamma != null && Number.isFinite(prevNetGamma) ? prevNetGamma : null;
  const curr = Number.isFinite(netGamma) ? netGamma : null;
  if (
    prev != null &&
    curr != null &&
    Math.sign(prev) !== 0 &&
    Math.sign(curr) !== 0 &&
    Math.sign(prev) !== Math.sign(curr)
  ) {
    Sentry.addBreadcrumb({
      category: 'dealer-regime',
      message: `${ticker} dealer-gamma sign flip`,
      level: 'info',
      data: {
        ticker,
        prevNetGamma: prev,
        newNetGamma: curr,
        spot: snapshot.spot,
      },
    });
    logger.info(
      {
        event: 'dealer_regime_sign_flip',
        ticker,
        prevNetGamma: prev,
        newNetGamma: curr,
        spot: snapshot.spot,
        confidence: result.confidence,
      },
      'dealer-regime sign flip',
    );
  }

  await withDbRetry(
    () => sql`
      INSERT INTO zero_gamma_levels (
        ticker, spot, zero_gamma, confidence,
        net_gamma_at_spot, gamma_curve
      )
      VALUES (
        ${ticker}, ${snapshot.spot}, ${zeroGamma}, ${result.confidence},
        ${netGamma}, ${gammaCurveJson}::jsonb
      )
      ON CONFLICT (ticker, ts) DO NOTHING
    `,
    2,
    10_000,
  );

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

export default withCronInstrumentation(
  'compute-zero-gamma',
  async (ctx): Promise<CronResult> => {
    const { today } = ctx;
    const sql = getDb();

    const perTicker: Record<
      string,
      TickerOutcome | { stored: false; error: string }
    > = {};

    // Track per-leg outcome for deriveCronStatus. A ticker with no snapshot
    // is a no-op skip (no data to work on), not a failure — it is excluded
    // from BOTH counters so a quiet window reports 'success', not 'error'.
    // `total` is the count of tickers that had real work (snapshot present),
    // `failed` is the count that threw.
    let failedLegs = 0;
    let totalLegs = 0;

    for (const ticker of ZERO_GAMMA_TICKERS) {
      try {
        const outcome = await processTicker(sql, ticker, today);
        perTicker[ticker] = outcome;
        // Only count tickers that had a snapshot to work on. A skipped
        // (no-snapshot) ticker is excluded from the leg counters.
        if (outcome.stored) {
          totalLegs += 1;
        }
      } catch (err) {
        // The wrapper sets `cron.job` once at entry; we only need the ticker
        // tag here so per-ticker exceptions are filterable in Sentry.
        Sentry.setTag('ticker', ticker);
        Sentry.captureException(err);
        logger.error({ err, ticker }, 'compute-zero-gamma: per-ticker failure');
        perTicker[ticker] = { stored: false, error: String(err) };
        totalLegs += 1;
        failedLegs += 1;
      }
    }

    // Collapse the per-leg outcome into a single status. When every ticker
    // that had work failed (or every ticker threw), this returns 'error'
    // instead of masking total failure as 'success'.
    const status = deriveCronStatus(failedLegs, totalLegs);

    return {
      status,
      metadata: { perTicker, failedLegs, totalLegs },
    };
  },
  { requireApiKey: false },
);
