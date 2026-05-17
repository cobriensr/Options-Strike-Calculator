/**
 * GET /api/cron/audit-takeit-calibration
 *
 * Phase 5 of takeit-phase3-production-scoring-2026-05-16.md.
 *
 * Monday 06:00 CT (11:00 UTC): for each alert type, pull last 7 days of
 * enriched fires that carry both `takeit_prob` and the realized outcome
 * `peak_ceiling_pct`, then:
 *
 *   1. Brier score = mean((prob − is_win)²) where is_win = 1 iff
 *      peak_ceiling_pct ≥ 20 (the win label the model was trained on).
 *   2. Calibration buckets — bin probabilities into deciles, report
 *      observed win rate vs. predicted mean per bucket. Drift shows up
 *      as a per-bucket residual.
 *   3. AUC on the same week's enriched fires (trivial — sort by prob,
 *      compute concordance).
 *
 * Emits Sentry metrics:
 *   - takeit.brier.{lottery,silentboom}        (distribution, weekly)
 *   - takeit.auc.{lottery,silentboom}          (distribution, weekly)
 *   - takeit.calibration.bucket_residual_abs   (distribution per-bucket)
 *   - takeit.brier_breach.{lottery,silentboom} (count when over threshold)
 *
 * Returns the same metric block in the cron-instrumentation response so
 * it surfaces in the Vercel cron log and Axiom dashboard alongside the
 * Sentry signal.
 */

import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';

/** Spec resolved-decision #5: peak_ceiling_pct ≥ 20 → win = 1. */
const WIN_LABEL_THRESHOLD_PCT = 20;

/** Spec resolved-decision #1 threshold from ml/src/takeit/config.py.
 *  Mirror it on the TS side so the alert path doesn't depend on Python
 *  metadata being readable from the runtime. */
const BRIER_ALERT_THRESHOLD = 0.27;

/** Sliding lookback used to populate the weekly metric. Matches the
 *  Sentry chart cadence. */
const LOOKBACK_DAYS = 7;

/** Number of equal-width probability buckets for the reliability table. */
const N_BUCKETS = 10;

type AlertType = 'lottery' | 'silentboom';

interface CalibrationRow {
  prob: number;
  win: 0 | 1;
}

interface AuditResult {
  n: number;
  brier: number | null;
  auc: number | null;
  brier_ok: boolean;
  bucket_residuals: Array<{
    bucket_lo: number;
    bucket_hi: number;
    n: number;
    mean_pred: number;
    observed_rate: number;
    residual_abs: number;
  }>;
}

function computeBrier(rows: CalibrationRow[]): number {
  let sum = 0;
  for (const r of rows) {
    const diff = r.prob - r.win;
    sum += diff * diff;
  }
  return sum / rows.length;
}

/**
 * AUC via concordance — for each (pos, neg) pair, fraction where the
 * positive has the higher predicted prob. O(N²) but N here is at most
 * ~5K rows per week per alert type, fine for a Monday cron.
 */
function computeAuc(rows: CalibrationRow[]): number | null {
  const positives = rows.filter((r) => r.win === 1).map((r) => r.prob);
  const negatives = rows.filter((r) => r.win === 0).map((r) => r.prob);
  if (positives.length === 0 || negatives.length === 0) return null;
  let concordant = 0;
  let ties = 0;
  for (const p of positives) {
    for (const n of negatives) {
      if (p > n) concordant++;
      else if (p === n) ties++;
    }
  }
  return (concordant + 0.5 * ties) / (positives.length * negatives.length);
}

function computeBuckets(
  rows: CalibrationRow[],
): AuditResult['bucket_residuals'] {
  const width = 1 / N_BUCKETS;
  const result: AuditResult['bucket_residuals'] = [];
  for (let i = 0; i < N_BUCKETS; i++) {
    const lo = i * width;
    const hi = (i + 1) * width;
    const inBucket = rows.filter(
      (r) => r.prob >= lo && (i === N_BUCKETS - 1 ? r.prob <= hi : r.prob < hi),
    );
    if (inBucket.length === 0) {
      result.push({
        bucket_lo: lo,
        bucket_hi: hi,
        n: 0,
        mean_pred: NaN,
        observed_rate: NaN,
        residual_abs: NaN,
      });
      continue;
    }
    const meanPred =
      inBucket.reduce((acc, r) => acc + r.prob, 0) / inBucket.length;
    const observed =
      inBucket.reduce((acc, r) => acc + r.win, 0) / inBucket.length;
    result.push({
      bucket_lo: lo,
      bucket_hi: hi,
      n: inBucket.length,
      mean_pred: meanPred,
      observed_rate: observed,
      residual_abs: Math.abs(meanPred - observed),
    });
  }
  return result;
}

async function auditOne(alertType: AlertType): Promise<AuditResult> {
  const db = getDb();
  const rows =
    alertType === 'lottery'
      ? ((await db`
          SELECT
            takeit_prob::float AS prob,
            (peak_ceiling_pct >= ${WIN_LABEL_THRESHOLD_PCT})::int AS win
          FROM lottery_finder_fires
          WHERE takeit_prob IS NOT NULL
            AND peak_ceiling_pct IS NOT NULL
            AND date >= CURRENT_DATE - (${LOOKBACK_DAYS}::int * INTERVAL '1 day')
        `) as Array<{ prob: number; win: 0 | 1 }>)
      : ((await db`
          SELECT
            takeit_prob::float AS prob,
            (peak_ceiling_pct >= ${WIN_LABEL_THRESHOLD_PCT})::int AS win
          FROM silent_boom_alerts
          WHERE takeit_prob IS NOT NULL
            AND peak_ceiling_pct IS NOT NULL
            AND date >= CURRENT_DATE - (${LOOKBACK_DAYS}::int * INTERVAL '1 day')
        `) as Array<{ prob: number; win: 0 | 1 }>);

  if (rows.length === 0) {
    return {
      n: 0,
      brier: null,
      auc: null,
      brier_ok: true,
      bucket_residuals: [],
    };
  }

  const calibrationRows: CalibrationRow[] = rows.map((r) => ({
    prob: Number(r.prob),
    win: (Number(r.win) === 1 ? 1 : 0) as 0 | 1,
  }));

  const brier = computeBrier(calibrationRows);
  const auc = computeAuc(calibrationRows);
  const brierOk = brier < BRIER_ALERT_THRESHOLD;

  // Sentry metrics — one observation per alert type per week.
  Sentry.metrics.distribution('takeit.brier', brier, {
    attributes: { alert_type: alertType },
  });
  if (auc != null) {
    Sentry.metrics.distribution('takeit.auc', auc, {
      attributes: { alert_type: alertType },
    });
  }
  if (!brierOk) {
    Sentry.metrics.count('takeit.brier_breach', 1, {
      attributes: {
        alert_type: alertType,
        threshold: String(BRIER_ALERT_THRESHOLD),
      },
    });
    // Also page via a Sentry message so the existing alert routes pick it up.
    Sentry.captureMessage('takeit.brier above threshold', {
      level: 'warning',
      extra: {
        alertType,
        brier,
        threshold: BRIER_ALERT_THRESHOLD,
        n_rows: calibrationRows.length,
      },
    });
  }

  const buckets = computeBuckets(calibrationRows);
  for (const b of buckets) {
    if (b.n > 0 && Number.isFinite(b.residual_abs)) {
      Sentry.metrics.distribution(
        'takeit.calibration.bucket_residual_abs',
        b.residual_abs,
        {
          attributes: {
            alert_type: alertType,
            bucket: `${b.bucket_lo.toFixed(1)}-${b.bucket_hi.toFixed(1)}`,
          },
        },
      );
    }
  }

  return {
    n: calibrationRows.length,
    brier,
    auc,
    brier_ok: brierOk,
    bucket_residuals: buckets,
  };
}

async function auditHandler(): Promise<CronResult> {
  const lottery = await auditOne('lottery');
  const silentboom = await auditOne('silentboom');
  return {
    status: 'success',
    rows: lottery.n + silentboom.n,
    metadata: { lottery, silentboom },
  };
}

export default withCronInstrumentation(
  'audit-takeit-calibration',
  auditHandler,
);

// Exported for tests.
export { computeAuc, computeBrier, computeBuckets };
