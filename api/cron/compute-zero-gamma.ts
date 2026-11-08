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
 * `zero_gamma` is NULL only when the gamma profile has no sign change in the
 * ±3% grid.
 *
 * What it will not compute from (docs/superpowers/specs/
 * live-data-integrity-2026-11-06.md, P0.4; F8 was 2,051 frozen rows and ~324
 * pre-open rows up to 120 SPX points off):
 *   - R-stale: a ticker whose newest `strike_exposures` snapshot is from an
 *     earlier ET day, or from today but older than 15 minutes, is skipped
 *     (`stale` / `stale_source`). Before, a stalled source ladder was
 *     recomputed every 5 minutes into a fresh-looking row.
 *   - no snapshot at all (`empty`) or no gamma on any strike (`all_zero`).
 *   Every skip follows the one rule in api/_lib/ladder-skip.ts: a warning, a
 *   metric, and from 09:40 ET a Sentry error. A run in which every ticker was
 *   skipped reports `skipped`, never `success`.
 *
 * R6: the row is keyed on its source, not on the compute time. `ts` = the END
 * of the source ladder's 5-minute bucket (zeroGammaLabelTs: the ladder's
 * `strike_exposures.timestamp`, which is UW's row time floored to 5 minutes,
 * plus 5 minutes). The `ts` column default (NOW()) made
 * `ON CONFLICT (ticker, ts) DO NOTHING` a no-op, so recomputing one ladder
 * wrote a new row each run (F8's 2,051 frozen rows). Now it writes nothing.
 * The bucket END, not the floor, because a ladder observed at :02 or :03 is
 * stamped :00, and a label at :00 would put the row up to about 4 minutes
 * before its data existed: lookahead for a `ts <= at` reader. At compute time
 * (:04) the newest row's label (:05) is about a minute AHEAD of the clock;
 * the staleness gates read `now - ts`, which is negative, so it is fresh.
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
import { reportLadderSkip } from '../_lib/ladder-skip.js';
import { isBeforeEtDay, type LadderSkipKind } from '../_lib/strike-ladder.js';
import { computeZeroGammaLevel, type GexStrike } from '../_lib/zero-gamma.js';
import { zeroGammaLabelTs } from '../_lib/zero-gamma-label.js';
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
 * R-stale: the oldest a source ladder (its `strike_exposures.timestamp`, the
 * START of its 5-minute bucket) may be and still be computed from. The source
 * is written every 5 minutes and this cron runs 1 minute after it, so a
 * healthy ladder's bucket started about 4 to 5 minutes before the run (UW row
 * time :02 or :03 is stamped :00, the run is at :04). 15 minutes tolerates
 * one missed fetch (a run at :14 still sees the :00 ladder, 14 minutes old).
 * The dealer-regime tile has the same 15 minutes (REGIME_CONSTANTS.staleAgeMs)
 * but measures it from the row's label, the ladder plus 5 minutes, so it calls
 * a row stale only once its ladder is about 20 minutes old.
 */
const SOURCE_MAX_AGE_MS = 15 * 60_000;

/**
 * The newest per-strike snapshot time for the ticker at its primary expiry,
 * or null when `strike_exposures` has no row for it today.
 *
 * `strike_exposures` holds per-(date, timestamp, ticker, strike, expiry)
 * rows written every 5 minutes. A single coherent snapshot is the latest
 * timestamp that has at least one row for (ticker, primary expiry).
 */
async function loadLatestTs(
  sql: ReturnType<typeof getDb>,
  ticker: ZeroGammaTicker,
  today: string,
  expiry: string,
): Promise<string | null> {
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

  return latestTsRaw instanceof Date
    ? latestTsRaw.toISOString()
    : new Date(latestTsRaw).toISOString();
}

type SnapshotLoad =
  | { kind: 'ok'; snapshot: SnapshotBundle }
  /** No row, or no usable spot, at that timestamp. */
  | { kind: 'empty' }
  /** Rows, but no gamma on any strike. */
  | { kind: 'all_zero' };

/** Every strike on the snapshot at `latestTs`. */
async function loadSnapshot(
  sql: ReturnType<typeof getDb>,
  ticker: ZeroGammaTicker,
  today: string,
  expiry: string,
  latestTs: string,
): Promise<SnapshotLoad> {
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

  if (rows.length === 0) return { kind: 'empty' };

  // `price` is the helper spot fetch-strike-exposure stores on every row of a
  // ladder (P0.3; UW's own per-strike price can lag by hours), so the first
  // row's price is the spot. Rows stored before that change carry UW's price.
  const spot = Number(rows[0]!.price);
  if (!Number.isFinite(spot) || spot <= 0) return { kind: 'empty' };

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

  if (strikes.length === 0) return { kind: 'all_zero' };

  return { kind: 'ok', snapshot: { spot, timestamp: latestTs, strikes } };
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
  /** Not computed or not written, and not a failure. */
  skipped?: true;
  /** Which of the one-rule skip kinds (api/_lib/ladder-skip.ts), if any. */
  skip?: LadderSkipKind;
  reason?: string;
  spot?: number;
  zeroGamma?: number | null;
  confidence?: number;
}

/**
 * One ticker's skip: report it by the one rule, and say so in the response.
 * `reportLadderSkip` warns, counts the metric and, from 09:40 ET, sends a
 * Sentry error.
 */
function skipTicker(
  kind: LadderSkipKind,
  ticker: ZeroGammaTicker,
  expiry: string,
  today: string,
  reason: string,
  detail: Record<string, unknown> = {},
): TickerOutcome {
  reportLadderSkip({
    job: 'compute-zero-gamma',
    kind,
    ticker,
    expiry,
    detail: { today, ...detail },
  });
  return { stored: false, skipped: true, skip: kind, reason };
}

/**
 * Process one ticker end-to-end: check the source's age → load snapshot →
 * compute → insert. Throws on DB errors (caught by the caller's per-ticker
 * try/catch so one bad ticker does not abort the rest of the loop).
 */
async function processTicker(
  sql: ReturnType<typeof getDb>,
  ticker: ZeroGammaTicker,
  today: string,
): Promise<TickerOutcome> {
  const expiry = getPrimaryExpiry(ticker, today);
  const latestTs = await loadLatestTs(sql, ticker, today, expiry);

  if (latestTs == null) {
    return skipTicker(
      'empty',
      ticker,
      expiry,
      today,
      'No strike_exposures snapshot',
    );
  }

  // R-stale: never compute from a source that has stopped moving. The row
  // that comes out is keyed on the ladder, but a fresh-looking compute of
  // yesterday's close (the pre-open ladder) or of a ladder that froze an hour
  // ago is still a wrong "current" level.
  if (isBeforeEtDay(latestTs, today)) {
    return skipTicker(
      'stale',
      ticker,
      expiry,
      today,
      'stale snapshot (earlier ET day)',
      { snapshotTs: latestTs },
    );
  }
  const ageMs = Date.now() - Date.parse(latestTs);
  if (ageMs > SOURCE_MAX_AGE_MS) {
    return skipTicker(
      'stale_source',
      ticker,
      expiry,
      today,
      'stale snapshot (older than 15 minutes)',
      { snapshotTs: latestTs, ageMinutes: Math.round(ageMs / 60_000) },
    );
  }

  const loaded = await loadSnapshot(sql, ticker, today, expiry, latestTs);
  if (loaded.kind === 'empty') {
    return skipTicker(
      'empty',
      ticker,
      expiry,
      today,
      'No strike_exposures snapshot',
      { snapshotTs: latestTs },
    );
  }
  if (loaded.kind === 'all_zero') {
    return skipTicker(
      'all_zero',
      ticker,
      expiry,
      today,
      'No gamma on any strike of the snapshot',
      { snapshotTs: latestTs },
    );
  }
  const snapshot = loaded.snapshot;

  const result = computeZeroGammaLevel(snapshot.strikes, snapshot.spot);

  // No confidence gate: zero-gamma is a regime indicator, not a trade
  // trigger — we want to see the level whenever the calculator can find
  // a sign change in ±3% of spot. `confidence` is stored alongside so
  // consumers can dim/style low-confidence reads in the UI.
  const zeroGamma = result.level;

  const netGamma = netGammaAtSpot(result.curve, snapshot.spot);
  const gammaCurveJson = JSON.stringify(result.curve);

  // R6: keyed on the source ladder. `ts` is the END of the ladder's bucket
  // (see the header), so computing the same ladder again conflicts on
  // (ticker, ts) and RETURNING yields no row: nothing is written, and nothing
  // below runs for it.
  const labelTs = zeroGammaLabelTs(snapshot.timestamp);
  const inserted = (await withDbRetry(
    () => sql`
      INSERT INTO zero_gamma_levels (
        ticker, spot, zero_gamma, confidence,
        net_gamma_at_spot, gamma_curve, ts
      )
      VALUES (
        ${ticker}, ${snapshot.spot}, ${zeroGamma}, ${result.confidence},
        ${netGamma}, ${gammaCurveJson}::jsonb, ${labelTs}::timestamptz
      )
      ON CONFLICT (ticker, ts) DO NOTHING
      RETURNING id
    `,
    2,
    10_000,
  )) as Array<{ id: number }>;
  if (inserted.length === 0) {
    logger.info(
      { ticker, snapshotTs: snapshot.timestamp },
      'compute-zero-gamma: ladder already stored — nothing to write',
    );
    return {
      stored: false,
      skipped: true,
      reason: 'ladder already stored',
    };
  }

  // Sign-flip detection: compare this ladder's net γ with the previous
  // LADDER's (`ts` strictly before this one's label, so never the row just
  // written; `<=` would read it and the flip would never be seen).
  // When the sign changes between successive ladders, dealer-gamma regime
  // flipped (long-γ ↔ short-γ at spot) — a load-bearing event for
  // post-mortem context on trades that misfire around the transition.
  // We log + breadcrumb here rather than alert because the flip is
  // expected behavior, just one we want to be able to grep for.
  const prevRows = (await withDbRetry(
    () => sql`
      SELECT net_gamma_at_spot::numeric AS net_gamma_at_spot
      FROM zero_gamma_levels
      WHERE ticker = ${ticker}
        AND ts < ${labelTs}::timestamptz
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
      labelTs,
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

    // Track per-leg outcome for deriveCronStatus. A skipped ticker (no
    // snapshot, a stale or all-zero source, a ladder already stored) is not a
    // failure — it is excluded from BOTH counters. `total` is the count of
    // tickers that stored a row or threw, `failed` is the count that threw.
    let failedLegs = 0;
    let totalLegs = 0;
    let skippedLegs = 0;

    for (const ticker of ZERO_GAMMA_TICKERS) {
      try {
        const outcome = await processTicker(sql, ticker, today);
        perTicker[ticker] = outcome;
        if (outcome.stored) {
          totalLegs += 1;
        } else if (outcome.skipped) {
          skippedLegs += 1;
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
    // instead of masking total failure as 'success'. A run in which nothing
    // was stored and every ticker was skipped did not do its job either:
    // 'skipped', never 'success'.
    let status = deriveCronStatus(failedLegs, totalLegs);
    if (status === 'success' && totalLegs === 0 && skippedLegs > 0) {
      status = 'skipped';
    }

    return {
      status,
      metadata: { perTicker, failedLegs, totalLegs, skippedLegs },
    };
  },
  { requireApiKey: false },
);
