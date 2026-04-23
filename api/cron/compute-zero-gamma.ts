/**
 * GET /api/cron/compute-zero-gamma
 *
 * Computes the SPX zero-gamma level during market hours. Reads the latest
 * per-strike intraday gamma snapshot from strike_exposures (written by
 * fetch-strike-exposure on a staggered 5-min cadence via the UW
 * expiry-strike endpoint), aggregates call + put OI gamma into a signed
 * per-strike dealer gamma profile, and hands it to the pure
 * computeZeroGammaLevel() calculator in api/_lib/zero-gamma.
 *
 * Outputs land in zero_gamma_levels (migration 82):
 *   - ticker, spot, zero_gamma (confidence-gated, nullable)
 *   - confidence (raw), net_gamma_at_spot, gamma_curve (JSONB)
 *
 * Gating:
 *   - confidence < 0.5 → zero_gamma column is stored as NULL. The confidence
 *     and curve are preserved for diagnostics so downstream consumers can
 *     see the low-confidence read without trusting the level itself.
 *   - If there is no fresh strike_exposures snapshot, the handler logs + exits
 *     without inserting (no-op).
 *
 * Expiry scope: 0DTE-only (expiry = today) — user decision 2026-04-23,
 * overrides spec open question #2 ("combined book"). Rationale: the app is
 * 0DTE-focused; 0DTE-only zero-gamma is most actionable for real-time
 * regime-flip detection during the session. Revisit if intraday regime
 * flips look too jittery (add a combined-book ticker variant like "SPX-ALL").
 *
 * Cadence: 5-min, matched to fetch-strike-exposure source (avoids 4-of-5
 * duplicate rows per real snapshot).
 *
 * Cron: 3,8,13,18,23,28,33,38,43,48,53,58 13-21 * * 1-5
 *
 * Environment: CRON_SECRET (no UW API key required — purely derivative)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { cronGuard } from '../_lib/api-helpers.js';
import { computeZeroGammaLevel, type GexStrike } from '../_lib/zero-gamma.js';

const TICKER = 'SPX';
const CONFIDENCE_MIN = 0.5;

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
 * Load the most recent per-strike gamma snapshot for SPX 0DTE.
 *
 * strike_exposures holds per-(date, timestamp, ticker, strike, expiry) rows
 * written every 5 minutes. We want a single coherent snapshot: the latest
 * timestamp that has at least one row, plus every strike on that timestamp.
 * We prefer 0DTE (expiry = today) because that's where the gamma wall lives
 * on a 0DTE-heavy book — returns null if no rows for today are available.
 */
async function loadLatestSnapshot(
  sql: ReturnType<typeof getDb>,
  today: string,
): Promise<SnapshotBundle | null> {
  // Latest timestamp with any rows for today's 0DTE snapshot.
  const latestTsRows = (await sql`
    SELECT MAX(timestamp) AS latest_ts
    FROM strike_exposures
    WHERE date = ${today}
      AND ticker = ${TICKER}
      AND expiry = ${today}
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
      AND ticker = ${TICKER}
      AND expiry = ${today}
      AND timestamp = ${latestTs}
    ORDER BY strike ASC
  `) as StrikeExposureRow[];

  if (rows.length === 0) return null;

  const spot = Number(rows[0]!.price);
  if (!Number.isFinite(spot) || spot <= 0) return null;

  // Combine call + put OI gamma into signed dealer gamma per strike.
  // Call gamma is positive from a dealer-long-gamma perspective, put gamma
  // is the mirror. UW already publishes signed values on these columns —
  // we just sum them per strike. Strikes missing both values are skipped.
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
 * APPROACH (A) — closest grid point.
 *
 * The calculator samples 30 candidate spots across ±3% of `spot`, so the
 * true spot usually falls between two adjacent grid points. We pick the
 * closest sample by absolute spot delta. The grid step is ~0.2% of spot
 * (e.g. ~15 pts at SPX 7100), which is well below the regime-detection
 * noise floor — small enough that a closest-point read is indistinguishable
 * from a full re-kernel for monitoring purposes.
 *
 * Chose (A) over (B) "extend the calculator" because it keeps the pure
 * calculator + its 9-test suite from Task A completely untouched; chose
 * (A) over (C) "interpolate" because the grid is already fine enough that
 * extra machinery wouldn't improve the signal beyond the underlying
 * UW data quality.
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

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res, { requireApiKey: false });
  if (!guard) return;
  const { today } = guard;

  const startTime = Date.now();
  const sql = getDb();

  try {
    const snapshot = await loadLatestSnapshot(sql, today);
    if (snapshot == null) {
      logger.info(
        { ticker: TICKER, today },
        'compute-zero-gamma: no strike_exposures snapshot — skipping',
      );
      return res.status(200).json({
        job: 'compute-zero-gamma',
        skipped: true,
        reason: 'No strike_exposures snapshot',
        durationMs: Date.now() - startTime,
      });
    }

    const result = computeZeroGammaLevel(snapshot.strikes, snapshot.spot);

    // Confidence gating: noisy crossings still record a row (for diagnostics)
    // but zero_gamma itself is stored NULL to prevent downstream features
    // trusting a shallow read.
    const zeroGamma =
      result.level != null && result.confidence >= CONFIDENCE_MIN
        ? result.level
        : null;

    const netGamma = netGammaAtSpot(result.curve, snapshot.spot);
    const gammaCurveJson = JSON.stringify(result.curve);

    await sql`
      INSERT INTO zero_gamma_levels (
        ticker, spot, zero_gamma, confidence,
        net_gamma_at_spot, gamma_curve
      )
      VALUES (
        ${TICKER}, ${snapshot.spot}, ${zeroGamma}, ${result.confidence},
        ${netGamma}, ${gammaCurveJson}::jsonb
      )
    `;

    logger.info(
      {
        ticker: TICKER,
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

    return res.status(200).json({
      job: 'compute-zero-gamma',
      stored: true,
      ticker: TICKER,
      spot: snapshot.spot,
      zeroGamma,
      confidence: result.confidence,
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'compute-zero-gamma');
    Sentry.captureException(err);
    logger.error({ err }, 'compute-zero-gamma error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
