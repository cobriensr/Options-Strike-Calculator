/**
 * GET /api/cron/takeit-fill-shap
 *
 * Phase 3d of takeit-phase3-production-scoring-2026-05-16.md.
 *
 * Every 2 min: find lottery + silent-boom alerts with takeit_prob populated
 * but takeit_top_features still NULL, POST a batch to the Railway sidecar's
 * /takeit/explain endpoint, write the SHAP top-3 green / top-3 red flags
 * back to Postgres.
 *
 * Off-by-default: if `SIDECAR_TAKEIT_URL` or `SIDECAR_TAKEIT_SECRET` is
 * unset, the cron exits success with a "disabled" status. The detect path
 * doesn't depend on this — takeit_prob is already populated; top_features
 * is the optional flags-on-the-tile decoration.
 *
 * Same fail-open posture as the rest of the take-it stack:
 *   - sidecar unreachable / 5xx → Sentry warn + return 200 (try next tick)
 *   - sidecar 4xx → Sentry error (likely a config / auth bug)
 *   - DB write failures bubble up; cron-instrumentation logs + 500.
 */

import { getDb } from '../_lib/db.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import { Sentry } from '../_lib/sentry.js';

const BATCH_SIZE = 500;
// The Phase 1 feature set has 74 (lottery) / 49 (silentboom) features. The
// sidecar can derive features itself from the alert row — but to keep the
// network payload small AND to insulate the sidecar from feature-derivation
// drift, we send the raw alert-row columns and let the sidecar rebuild the
// feature record using the same takeit-features Python module that Phase 1
// uses. That's the contract; sidecar is the single source of truth for
// feature derivation in the SHAP path.

type AlertType = 'lottery' | 'silentboom';

interface SidecarRequestRow {
  alert_id: number;
  features: Record<string, number | null>;
}

interface SidecarResponse {
  results: Array<{
    alert_id: number;
    top_positive: Array<{
      name: string;
      shap_value: number;
      feature_value: unknown;
    }>;
    top_negative: Array<{
      name: string;
      shap_value: number;
      feature_value: unknown;
    }>;
  }>;
}

async function fillForAlertType(
  alertType: AlertType,
): Promise<{ scanned: number; updated: number; failed: number; reason?: string }> {
  const sidecarUrl = process.env.SIDECAR_TAKEIT_URL;
  const sidecarSecret = process.env.SIDECAR_TAKEIT_SECRET;
  if (!sidecarUrl || !sidecarSecret) {
    return { scanned: 0, updated: 0, failed: 0, reason: 'sidecar_disabled' };
  }

  const db = getDb();

  // Pull the most-recent unflagged rows first — they're the most useful to
  // surface flags for in the live UI. Separate branches keep the SQL
  // literal-table-name (neon-serverless tagged-template can't interpolate
  // identifiers) and let each return its own typed row shape.
  const rows =
    alertType === 'lottery'
      ? ((await db`
          SELECT * FROM lottery_finder_fires
          WHERE takeit_prob IS NOT NULL AND takeit_top_features IS NULL
          ORDER BY id DESC
          LIMIT ${BATCH_SIZE}
        `) as Array<Record<string, unknown> & { id: number }>)
      : ((await db`
          SELECT * FROM silent_boom_alerts
          WHERE takeit_prob IS NOT NULL AND takeit_top_features IS NULL
          ORDER BY id DESC
          LIMIT ${BATCH_SIZE}
        `) as Array<Record<string, unknown> & { id: number }>);

  if (rows.length === 0) {
    return { scanned: 0, updated: 0, failed: 0 };
  }

  // Build the request body. The sidecar's /takeit/explain accepts the row's
  // raw column dict and derives features Python-side via the same Phase 1
  // module that produced the trained features — no feature-derivation
  // duplication on the TS side here.
  const sidecarRows: SidecarRequestRow[] = rows.map((r) => ({
    alert_id: r.id,
    features: r as Record<string, number | null>,
  }));

  let payload: SidecarResponse;
  try {
    const res = await fetch(`${sidecarUrl}/takeit/explain`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sidecarSecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ alert_type: alertType, rows: sidecarRows }),
    });
    if (!res.ok) {
      Sentry.captureMessage('takeit.shap_fill.sidecar_non_2xx', {
        level: res.status >= 500 ? 'warning' : 'error',
        extra: { alertType, status: res.status, statusText: res.statusText },
      });
      return {
        scanned: rows.length,
        updated: 0,
        failed: rows.length,
        reason: `sidecar_${res.status}`,
      };
    }
    payload = (await res.json()) as SidecarResponse;
  } catch (err) {
    Sentry.captureMessage('takeit.shap_fill.sidecar_unreachable', {
      level: 'warning',
      extra: { alertType, error: (err as Error).message },
    });
    return {
      scanned: rows.length,
      updated: 0,
      failed: rows.length,
      reason: 'sidecar_unreachable',
    };
  }

  let updated = 0;
  for (const result of payload.results) {
    const topFeatures = {
      positive: result.top_positive,
      negative: result.top_negative,
    };
    if (alertType === 'lottery') {
      await db`
        UPDATE lottery_finder_fires
        SET takeit_top_features = ${JSON.stringify(topFeatures)}::jsonb
        WHERE id = ${result.alert_id}
      `;
    } else {
      await db`
        UPDATE silent_boom_alerts
        SET takeit_top_features = ${JSON.stringify(topFeatures)}::jsonb
        WHERE id = ${result.alert_id}
      `;
    }
    updated += 1;
  }

  return { scanned: rows.length, updated, failed: rows.length - updated };
}

async function takeitFillShapHandler(): Promise<CronResult> {
  const lottery = await fillForAlertType('lottery');
  const silentboom = await fillForAlertType('silentboom');

  return {
    status: 'success',
    rows: lottery.updated + silentboom.updated,
    metadata: { lottery, silentboom },
  };
}

export default withCronInstrumentation('takeit-fill-shap', takeitFillShapHandler);
