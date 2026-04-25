/**
 * GET /api/cron/resolve-iv-anomalies
 *
 * End-of-day cron that labels every `iv_anomalies` row from today that
 * still has `resolution_outcome IS NULL`. For each unresolved anomaly:
 *
 *   1. Pull every follow-on `strike_iv_snapshots` row between the
 *      anomaly's ts and 4pm ET close (same ticker/strike/side/expiry).
 *   2. Score the trade economics via the pure `resolveAnomaly()`.
 *   3. Pull the T-60 → T+0 cross-asset time series + dark-pool prints
 *      + flow alerts, hand to `analyzeCatalysts()` for retrospective
 *      leading-lag analysis.
 *   4. UPDATE the row's `resolution_outcome` JSONB with the combined
 *      economics + catalysts.
 *
 * Runs at `5 21 * * 1-5` (≈5 min after 4pm ET). Market-hours guard is
 * OFF — this runs strictly after close.
 *
 * Fault tolerance: a single anomaly that fails to resolve (missing
 * follow-on data, unexpected shape) logs a warn + captures to Sentry
 * but does not abort the batch. Returns { resolved, skipped } counts.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { cronGuard } from '../_lib/api-helpers.js';
import {
  resolveAnomaly,
  type AnomalyForResolve,
  type FollowOnSample,
  type ResolveEconomics,
} from '../_lib/iv-anomaly.js';
import {
  analyzeCatalysts,
  type AnomalySeries,
  type Catalysts,
  type CrossAssetSeries,
  type DarkPrintRow,
  type FlowAlertRow,
} from '../_lib/anomaly-catalyst.js';
import { CATALYST_WINDOW_MINS } from '../_lib/constants.js';
import { getETDateStr, getETCloseUtcIso } from '../../src/utils/timezone.js';

// ── Row shapes ──────────────────────────────────────────────

interface IVAnomalyRow {
  id: number;
  ticker: string;
  strike: string | number;
  side: string;
  expiry: string | Date;
  spot_at_detect: string | number;
  iv_at_detect: string | number;
  ts: string | Date;
}

function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function isoTs(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

// ── Query: unresolved anomalies for today ───────────────────

async function loadUnresolvedAnomalies(
  sql: ReturnType<typeof getDb>,
  today: string,
): Promise<IVAnomalyRow[]> {
  // Partial index idx_iv_anomalies_unresolved on (ts) WHERE
  // resolution_outcome IS NULL covers this scan directly.
  const rows = (await sql`
    SELECT id, ticker, strike, side, expiry,
           spot_at_detect, iv_at_detect, ts
    FROM iv_anomalies
    WHERE resolution_outcome IS NULL
      AND DATE(ts AT TIME ZONE 'America/New_York') = ${today}
    ORDER BY ts ASC
  `) as IVAnomalyRow[];
  return rows;
}

// ── Query: follow-on strike_iv_snapshots between anomaly.ts and close ─

interface SnapshotFollowRow {
  ts: string | Date;
  iv_mid: string | number | null;
  spot: string | number;
}

async function loadFollowOnSamples(
  sql: ReturnType<typeof getDb>,
  anomaly: AnomalyForResolve,
  closeIso: string,
): Promise<FollowOnSample[]> {
  // Composite index idx_strike_iv_snapshots_lookup on
  // (ticker, strike, side, expiry, ts DESC) covers this range scan.
  const expiryDate =
    anomaly.expiry.length === 10 ? anomaly.expiry : anomaly.expiry.slice(0, 10);
  const rows = (await sql`
    SELECT ts, iv_mid, spot
    FROM strike_iv_snapshots
    WHERE ticker = ${anomaly.ticker}
      AND strike = ${anomaly.strike}
      AND side = ${anomaly.side}
      AND expiry = ${expiryDate}
      AND ts > ${anomaly.ts}
      AND ts <= ${closeIso}
    ORDER BY ts ASC
  `) as SnapshotFollowRow[];

  return rows
    .map((r) => {
      const spot = toNum(r.spot);
      if (spot == null) return null;
      const sample: FollowOnSample = {
        ts: isoTs(r.ts),
        iv_mid: r.iv_mid == null ? null : toNum(r.iv_mid),
        spot,
      };
      return sample;
    })
    .filter((s): s is FollowOnSample => s != null);
}

// ── Query: anomaly-ticker spot series in the T-60 window ────

async function loadAnomalySeries(
  sql: ReturnType<typeof getDb>,
  ticker: string,
  startIso: string,
  endIso: string,
): Promise<AnomalySeries> {
  // Use strike_iv_snapshots.spot — populated every minute by Phase 1.
  // DISTINCT ON (ts) to dedupe rows from different strikes at the same
  // minute (they all share the same spot anyway).
  const rows = (await sql`
    SELECT DISTINCT ON (ts) ts, spot
    FROM strike_iv_snapshots
    WHERE ticker = ${ticker}
      AND ts >= ${startIso}
      AND ts <= ${endIso}
    ORDER BY ts ASC
  `) as Array<{ ts: string | Date; spot: string | number }>;
  return {
    ticker,
    samples: rows
      .map((r) => ({ ts: isoTs(r.ts), spot: toNum(r.spot) ?? 0 }))
      .filter((s) => s.spot > 0),
  };
}

// ── Query: cross-asset series from futures_bars ──────────────

// The cross-assets we correlate against for catalyst analysis. Matches
// the macro-backdrop set exposed in anomaly-context.ts: ZN as the bond
// proxy (TLT stand-in), DX as dollar (DXY stand-in), plus ES+NQ as
// the index leaders. Kept compact so the T-60 window query fan-out
// stays cheap and test fixtures are readable.
const CROSS_ASSET_FUTURES = ['ES', 'NQ', 'ZN', 'DX'] as const;

async function loadFuturesSeries(
  sql: ReturnType<typeof getDb>,
  symbol: string,
  startIso: string,
  endIso: string,
): Promise<Array<{ ts: string; spot: number }>> {
  const rows = (await sql`
    SELECT ts, close
    FROM futures_bars
    WHERE symbol = ${symbol}
      AND ts >= ${startIso}
      AND ts <= ${endIso}
    ORDER BY ts ASC
  `) as Array<{ ts: string | Date; close: string | number }>;
  return rows
    .map((r) => ({ ts: isoTs(r.ts), spot: toNum(r.close) ?? 0 }))
    .filter((s) => s.spot > 0);
}

async function loadCrossAssets(
  sql: ReturnType<typeof getDb>,
  startIso: string,
  endIso: string,
): Promise<CrossAssetSeries[]> {
  const series = await Promise.all(
    CROSS_ASSET_FUTURES.map(async (symbol) => {
      const samples = await loadFuturesSeries(sql, symbol, startIso, endIso);
      return { ticker: symbol, samples };
    }),
  );
  return series;
}

// ── Query: dark-pool prints in window (SPX-scoped) ───────────

async function loadDarkPrintsInWindow(
  sql: ReturnType<typeof getDb>,
  startIso: string,
  endIso: string,
  todayDate: string,
): Promise<DarkPrintRow[]> {
  // dark_pool_levels is SPX-scoped in this repo + already filtered
  // per feedback_darkpool_filters.md upstream.
  const rows = (await sql`
    SELECT latest_time, total_premium
    FROM dark_pool_levels
    WHERE date = ${todayDate}
      AND latest_time >= ${startIso}
      AND latest_time <= ${endIso}
    ORDER BY latest_time ASC
  `) as Array<{ latest_time: string | Date; total_premium: string | number }>;
  return rows.map((r) => ({
    ticker: 'SPX',
    ts: isoTs(r.latest_time),
    notional: toNum(r.total_premium) ?? 0,
  }));
}

// ── Query: flow alerts for anomaly ticker in window ─────────

async function loadFlowAlertsInWindow(
  sql: ReturnType<typeof getDb>,
  ticker: string,
  startIso: string,
  endIso: string,
): Promise<FlowAlertRow[]> {
  const rows = (await sql`
    SELECT created_at, ticker, total_premium
    FROM flow_alerts
    WHERE ticker = ${ticker}
      AND created_at >= ${startIso}
      AND created_at <= ${endIso}
    ORDER BY created_at ASC
  `) as Array<{
    created_at: string | Date;
    ticker: string;
    total_premium: string | number | null;
  }>;
  return rows.map((r) => ({
    ts: isoTs(r.created_at),
    ticker: String(r.ticker ?? ''),
    premium: toNum(r.total_premium) ?? 0,
  }));
}

// ── Resolve one anomaly ─────────────────────────────────────

interface ResolveResult {
  status: 'resolved' | 'skipped';
  reason?: string;
}

async function resolveOne(
  sql: ReturnType<typeof getDb>,
  row: IVAnomalyRow,
  closeIso: string,
  todayDate: string,
): Promise<ResolveResult> {
  const anomaly: AnomalyForResolve = {
    ticker: row.ticker,
    strike: Number(row.strike),
    side: row.side === 'call' ? 'call' : 'put',
    expiry:
      row.expiry instanceof Date
        ? row.expiry.toISOString().slice(0, 10)
        : String(row.expiry).slice(0, 10),
    spot_at_detect: toNum(row.spot_at_detect) ?? 0,
    iv_at_detect: toNum(row.iv_at_detect) ?? 0,
    ts: isoTs(row.ts),
  };

  if (anomaly.spot_at_detect <= 0 || anomaly.iv_at_detect <= 0) {
    return { status: 'skipped', reason: 'invalid_detect_state' };
  }

  // Follow-on data for the economics score.
  const followOn = await loadFollowOnSamples(sql, anomaly, closeIso);

  // Near-close / missing-data skip: we still WANT to label these for ML
  // completeness, but warn so we can triage later if the pattern is
  // common. We label the row regardless — missing data just yields
  // detect == close economics and outcome_class 'flat'.
  if (followOn.length === 0) {
    logger.warn(
      {
        anomalyId: row.id,
        ticker: anomaly.ticker,
        strike: anomaly.strike,
        side: anomaly.side,
      },
      'resolve-iv-anomalies: no follow-on samples — labeling as flat',
    );
  }

  const economics = resolveAnomaly(anomaly, followOn, closeIso);

  // Catalyst analysis window.
  const detectMs = Date.parse(anomaly.ts);
  const windowStartIso = new Date(
    detectMs - CATALYST_WINDOW_MINS * 60_000,
  ).toISOString();

  const [anomalySeries, crossAssets, darkPrints, flowAlerts] =
    await Promise.all([
      loadAnomalySeries(sql, anomaly.ticker, windowStartIso, anomaly.ts),
      loadCrossAssets(sql, windowStartIso, anomaly.ts),
      // Dark prints only meaningful when the anomaly is on SPX (the
      // dark_pool_levels feed is SPX-scoped).
      anomaly.ticker === 'SPX'
        ? loadDarkPrintsInWindow(sql, windowStartIso, anomaly.ts, todayDate)
        : Promise.resolve([] as DarkPrintRow[]),
      loadFlowAlertsInWindow(sql, anomaly.ticker, windowStartIso, anomaly.ts),
    ]);

  const catalysts: Catalysts = analyzeCatalysts({
    anomaly: {
      ticker: anomaly.ticker,
      ts: anomaly.ts,
      side: anomaly.side,
    },
    anomalySeries,
    crossAssets,
    darkPrints,
    flowAlerts,
  });

  // Persist.
  const outcome: ResolveEconomics & { catalysts: Catalysts } = {
    ...economics,
    catalysts,
  };

  await sql`
    UPDATE iv_anomalies
    SET resolution_outcome = ${JSON.stringify(outcome)}::jsonb
    WHERE id = ${row.id}
  `;

  return { status: 'resolved' };
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Runs after 4pm ET close — skip the market-hours guard entirely.
  const guard = cronGuard(req, res, {
    marketHours: false,
    requireApiKey: false,
  });
  if (!guard) return;

  const startTime = Date.now();
  const sql = getDb();
  // Use ET-local date to match iv_anomalies.ts being stored with its
  // native TIMESTAMPTZ and to respect DST boundaries. 4pm ET = 21:00 UTC
  // during EST, 20:00 UTC during EDT — getETCloseUtcIso resolves the
  // actual UTC instant for the given ET date. Resolve cron runs at
  // 21:05 UTC so we're always ≥5 min past close during EST and ≥1h5min
  // past during EDT.
  const today = getETDateStr(new Date());
  const closeIso = getETCloseUtcIso(today);
  if (!closeIso) {
    logger.error({ today }, 'resolve-iv-anomalies: invalid ET date');
    return res.status(500).json({
      error: 'invalid_et_date',
      today,
    });
  }

  try {
    const unresolved = await loadUnresolvedAnomalies(sql, today);
    if (unresolved.length === 0) {
      logger.info(
        { today },
        'resolve-iv-anomalies: no unresolved anomalies — done',
      );
      return res.status(200).json({
        job: 'resolve-iv-anomalies',
        resolved: 0,
        skipped: 0,
        total: 0,
        durationMs: Date.now() - startTime,
      });
    }

    let resolved = 0;
    let skipped = 0;
    const skipReasons: Record<string, number> = {};

    for (const row of unresolved) {
      try {
        const result = await resolveOne(sql, row, closeIso, today);
        if (result.status === 'resolved') {
          resolved += 1;
        } else {
          skipped += 1;
          const reason = result.reason ?? 'unknown';
          skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
        }
      } catch (err) {
        skipped += 1;
        skipReasons['exception'] = (skipReasons['exception'] ?? 0) + 1;
        Sentry.setTag('cron.job', 'resolve-iv-anomalies');
        Sentry.setTag('anomaly.id', String(row.id));
        Sentry.captureException(err);
        logger.error(
          { err, anomalyId: row.id },
          'resolve-iv-anomalies: per-row failure — skipping',
        );
      }
    }

    const durationMs = Date.now() - startTime;
    logger.info(
      {
        today,
        total: unresolved.length,
        resolved,
        skipped,
        skipReasons,
        durationMs,
      },
      'resolve-iv-anomalies: done',
    );

    return res.status(200).json({
      job: 'resolve-iv-anomalies',
      date: today,
      total: unresolved.length,
      resolved,
      skipped,
      skipReasons,
      durationMs,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'resolve-iv-anomalies');
    Sentry.captureException(err);
    logger.error({ err }, 'resolve-iv-anomalies error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
