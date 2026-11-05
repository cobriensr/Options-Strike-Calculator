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
 * Required config: `SIDECAR_TAKEIT_URL` and `SIDECAR_TAKEIT_SECRET`. Both
 * are set in Vercel production, so a miss means a dropped or renamed
 * variable. The run then reports 'error' and raises
 * `takeit.shap_fill.config_missing` (naming the variables, never their
 * values); a green cron over a tile that silently never gets SHAP flags is
 * the failure to avoid. The detect path doesn't depend on this — takeit_prob
 * is already populated; top_features is the optional flags-on-the-tile
 * decoration.
 *
 * Status (R4: a run never reports `success` over a row it left unfilled).
 * Each alert type is a leg; the run reports the worst of the two:
 *   - nothing to fill, or every selected row filled → 'success'
 *   - sidecar transport failure (unreachable, timeout, 5xx, 429), or rows
 *     missing from an otherwise good answer → 'partial'. The next tick
 *     retries: an unfilled row keeps `takeit_top_features IS NULL`, so it
 *     stays in the shap-backlog partial index (migration #184) and gets
 *     selected again.
 *   - sidecar 4xx other than 429 (auth / config), or a 200 body that is not
 *     the contract (not JSON, wrong shape) → 'error': retrying the same call
 *     won't help. Returned, not thrown, so each still raises exactly one
 *     Sentry event from here and the cron monitor goes red.
 *   - DB write failure → captured once here. A Neon blip (retryable, the
 *     same classifier the detect crons use) is a warning and 'partial': the
 *     row stays IS NULL, so the next tick retries it. Anything else is a
 *     broken query, an error and 'error'. The other leg still runs.
 *   - A failed SELECT is not caught: it throws to the cron wrapper (500,
 *     one captureException, `error` run), as before.
 *
 * Counters stay in the Axiom `meta` (the `lottery` / `silentboom` legs);
 * the top-level `status`, `rows` and `message` are existing columns.
 */

import { z } from 'zod';

import { getDb, isRetryableDbError, withDbRetry } from '../_lib/db.js';
import {
  withCronInstrumentation,
  type CronResult,
  type CronStatus,
} from '../_lib/cron-instrumentation.js';
import { Sentry } from '../_lib/sentry.js';

// 100 (down from 500 on 2026-05-21). 500-row batches drove the
// Railway sidecar's /takeit/explain past the edge-proxy timeout —
// each call ran shap.TreeExplainer on the full batch and produced
// recurring `takeit.shap_fill.sidecar_non_2xx` 502s with no
// matching sidecar Sentry exception. With explainer caching now
// in place (see sidecar/src/takeit_server.py:_load_bundle) the
// remaining per-batch cost is `explainer.shap_values(X)` itself,
// which scales with N_rows — 100 keeps a single call well under
// the edge-proxy budget while the 2-minute cron cadence drains
// any backlog inside a few ticks.
//
// It also bounds the write: one UPDATE per alert type per run carries at
// most this many rows, under the ~500-row chunk size the repo batches at,
// so the write is never chunked.
const BATCH_SIZE = 100;
// Per-call cap on the sidecar fetch, an operational knob: it keeps a hung
// sidecar from running the function to its limit. Arithmetic: 2 legs x 20 s
// = 40 s, under the 60 s `maxDuration` for this file in vercel.json, which
// leaves 20 s for the two SELECTs and two UPDATEs. The signal also covers
// the body read; the abort (a TimeoutError) lands in sidecarUnreachable and
// reports 'partial'.
const SIDECAR_TIMEOUT_MS = 20_000;
// Phase 3d follow-up: read the persisted `takeit_features` JSONB written
// by the detect crons (scoreLottery / scoreSilentBoom return the same
// feature dict they used to score the prob). The sidecar consumes it
// directly — no re-derivation, no raw-row passthrough that would miss
// the derived flags + one-hot encoded categoricals the model was trained
// on. Rows where takeit_features IS NULL are skipped (legacy fires
// pre-migration #157 just stay unflagged forever).

type AlertType = 'lottery' | 'silentboom';

/**
 * BIGSERIAL: the Neon driver returns int8 as a STRING at runtime (see
 * enrich-lottery-outcomes.ts), though the sidecar and the tests also use
 * numbers. Ids are compared as strings and never arithmetic'd.
 */
type AlertId = string | number;

interface SidecarRequestRow {
  alert_id: AlertId;
  features: Record<string, number | null>;
}

interface FillCandidateRow {
  id: AlertId;
  takeit_features: Record<string, number | null> | null;
}

// The /takeit/explain contract (sidecar/src/takeit_server.py): one result per
// request row, echoing the alert_id it was sent. feature_value is a number or
// null there; the tile types it `unknown`, so no stricter here.
const contributionSchema = z.object({
  name: z.string(),
  shap_value: z.number(),
  feature_value: z.unknown(),
});

const sidecarResponseSchema = z.object({
  results: z.array(
    z.object({
      alert_id: z.union([z.string(), z.number()]),
      top_positive: z.array(contributionSchema),
      top_negative: z.array(contributionSchema),
    }),
  ),
});

type SidecarResult = z.infer<typeof sidecarResponseSchema>['results'][number];

type LegStatus = Exclude<CronStatus, 'skipped'>;

/** One alert type's outcome. Lands in the Axiom `meta` as-is. */
interface FillLeg {
  status: LegStatus;
  /** Rows the backlog SELECT returned. */
  scanned: number;
  /** Rows this run's UPDATE actually wrote (RETURNING). */
  updated: number;
  /** Rows left unfilled by a sidecar or DB problem, to be retried. */
  failed: number;
  /**
   * Rows the sidecar answered but the IS NULL guard skipped: filled by
   * another run, or by an earlier attempt of this UPDATE that committed
   * after withDbRetry's per-attempt timeout.
   */
  alreadyFilled: number;
  reason?: string;
}

type SidecarOutcome =
  | { ok: true; results: SidecarResult[] }
  | { ok: false; status: Exclude<LegStatus, 'success'>; reason: string };

const STATUS_RANK: Record<LegStatus, number> = {
  success: 0,
  partial: 1,
  error: 2,
};

function worstStatus(a: LegStatus, b: LegStatus): LegStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

function sidecarUnreachable(
  alertType: AlertType,
  err: unknown,
): SidecarOutcome {
  Sentry.captureMessage('takeit.shap_fill.sidecar_unreachable', {
    level: 'warning',
    extra: {
      alertType,
      error: err instanceof Error ? err.message : String(err),
    },
  });
  return { ok: false, status: 'partial', reason: 'sidecar_unreachable' };
}

function sidecarMalformed(
  alertType: AlertType,
  detail: string,
): SidecarOutcome {
  Sentry.captureMessage('takeit.shap_fill.sidecar_malformed_response', {
    level: 'error',
    extra: { alertType, detail },
  });
  return { ok: false, status: 'error', reason: 'sidecar_malformed_response' };
}

/**
 * POST one batch to /takeit/explain and classify what comes back. A transport
 * problem is 'partial' (a later call can succeed); a response that breaks the
 * contract is 'error' (the same call will fail the same way).
 */
async function explainBatch(
  sidecarUrl: string,
  sidecarSecret: string,
  alertType: AlertType,
  sidecarRows: SidecarRequestRow[],
): Promise<SidecarOutcome> {
  let res: Response;
  try {
    res = await fetch(`${sidecarUrl}/takeit/explain`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sidecarSecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ alert_type: alertType, rows: sidecarRows }),
      signal: AbortSignal.timeout(SIDECAR_TIMEOUT_MS),
    });
  } catch (err) {
    return sidecarUnreachable(alertType, err);
  }

  if (!res.ok) {
    // 5xx and 429 are the sidecar (or its edge proxy) being down, slow or
    // busy; any other 4xx is a bad secret or request, a bug that pages.
    const transient = res.status >= 500 || res.status === 429;
    Sentry.captureMessage('takeit.shap_fill.sidecar_non_2xx', {
      level: transient ? 'warning' : 'error',
      extra: { alertType, status: res.status, statusText: res.statusText },
    });
    return {
      ok: false,
      status: transient ? 'partial' : 'error',
      reason: `sidecar_${res.status}`,
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    // A body that parses as nothing is the contract broken. Anything else
    // thrown here (the stream cut mid-read) is the transport failing.
    if (err instanceof SyntaxError) {
      return sidecarMalformed(alertType, 'body is not JSON');
    }
    return sidecarUnreachable(alertType, err);
  }

  const parsed = sidecarResponseSchema.safeParse(body);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    return sidecarMalformed(alertType, detail);
  }
  return { ok: true, results: parsed.data.results };
}

/**
 * Write the SHAP flags for `ids` in one UPDATE ... FROM unnest, the repo's
 * batch shape (see lockTapeOutcomes in enrich-lottery-outcomes.ts). The
 * `IS NULL` guard keeps a concurrent fill from being overwritten (R6);
 * RETURNING counts the rows this call really wrote. `features` is one JSON
 * text per id, cast to jsonb server-side (the gexbot-store.ts shape).
 */
async function writeTopFeatures(
  db: ReturnType<typeof getDb>,
  alertType: AlertType,
  ids: AlertId[],
  features: string[],
): Promise<number> {
  const written =
    alertType === 'lottery'
      ? await withDbRetry(
          () => db`
            UPDATE lottery_finder_fires AS t
               SET takeit_top_features = u.f::jsonb
              FROM unnest(${ids}::bigint[], ${features}::text[]) AS u(id, f)
             WHERE t.id = u.id
               AND t.takeit_top_features IS NULL
            RETURNING t.id
          `,
          2,
          10_000,
        )
      : await withDbRetry(
          () => db`
            UPDATE silent_boom_alerts AS t
               SET takeit_top_features = u.f::jsonb
              FROM unnest(${ids}::bigint[], ${features}::text[]) AS u(id, f)
             WHERE t.id = u.id
               AND t.takeit_top_features IS NULL
            RETURNING t.id
          `,
          2,
          10_000,
        );
  return written.length;
}

async function fillForAlertType(
  alertType: AlertType,
  sidecar: { url: string; secret: string },
): Promise<FillLeg> {
  const db = getDb();

  // Pull the most-recent unflagged rows first — they're the most useful to
  // surface flags for in the live UI. We project only (id, takeit_features)
  // because that's all the sidecar needs; the JSONB blob already carries
  // the full bundle-shaped feature vector the detect cron persisted.
  // Filter on takeit_features IS NOT NULL: legacy rows pre-migration #157
  // can't get SHAP retroactively (no captured features at fire time) and
  // are skipped on purpose.
  const rows =
    alertType === 'lottery'
      ? ((await withDbRetry(
          () => db`
            SELECT id, takeit_features
            FROM lottery_finder_fires
            WHERE takeit_prob IS NOT NULL
              AND takeit_features IS NOT NULL
              AND takeit_top_features IS NULL
            ORDER BY id DESC
            LIMIT ${BATCH_SIZE}
          `,
          2,
          10_000,
        )) as FillCandidateRow[])
      : ((await withDbRetry(
          () => db`
            SELECT id, takeit_features
            FROM silent_boom_alerts
            WHERE takeit_prob IS NOT NULL
              AND takeit_features IS NOT NULL
              AND takeit_top_features IS NULL
            ORDER BY id DESC
            LIMIT ${BATCH_SIZE}
          `,
          2,
          10_000,
        )) as FillCandidateRow[]);

  if (rows.length === 0) {
    return {
      status: 'success',
      scanned: 0,
      updated: 0,
      failed: 0,
      alreadyFilled: 0,
    };
  }

  // Build the request body. takeit_features is already the bundle-shaped
  // dict (one-hots + derived flags) produced by scoreLottery/scoreSilentBoom
  // — ship it through unchanged so the sidecar's SHAP TreeExplainer sees
  // exactly the same matrix the prob scorer used.
  const sidecarRows: SidecarRequestRow[] = rows
    .filter(
      (
        r,
      ): r is FillCandidateRow & {
        takeit_features: Record<string, number | null>;
      } => r.takeit_features !== null,
    )
    .map((r) => ({
      alert_id: r.id,
      features: r.takeit_features,
    }));
  if (sidecarRows.length === 0) {
    return {
      status: 'success',
      scanned: rows.length,
      updated: 0,
      failed: 0,
      alreadyFilled: 0,
    };
  }

  const outcome = await explainBatch(
    sidecar.url,
    sidecar.secret,
    alertType,
    sidecarRows,
  );
  if (!outcome.ok) {
    return {
      status: outcome.status,
      scanned: rows.length,
      updated: 0,
      failed: rows.length,
      alreadyFilled: 0,
      reason: outcome.reason,
    };
  }

  // Walk the rows we SENT, not the answer: only a requested id can be
  // written (a stray or duplicated echo is ignored), and the arrays stay
  // aligned. The DB's own id goes into the UPDATE, never the echoed one.
  const answers = new Map<string, string>();
  for (const result of outcome.results) {
    answers.set(
      String(result.alert_id),
      JSON.stringify({
        positive: result.top_positive,
        negative: result.top_negative,
      }),
    );
  }
  const ids: AlertId[] = [];
  const features: string[] = [];
  for (const sent of sidecarRows) {
    const stored = answers.get(String(sent.alert_id));
    if (stored !== undefined) {
      ids.push(sent.alert_id);
      features.push(stored);
    }
  }
  const missing = sidecarRows.length - ids.length;
  if (missing > 0) {
    Sentry.captureMessage('takeit.shap_fill.rows_missing', {
      level: 'warning',
      extra: {
        alertType,
        requested: sidecarRows.length,
        answered: ids.length,
      },
    });
  }

  let updated = 0;
  if (ids.length > 0) {
    try {
      updated = await writeTopFeatures(db, alertType, ids, features);
    } catch (err) {
      // Captured here, once: a returned status never reaches the wrapper's
      // own captureException. A Neon blip degrades one run (warning,
      // 'partial': the rows stay IS NULL and the next tick retries them);
      // any other rejection is a broken query, a bug that pages (error).
      const transient = isRetryableDbError(err);
      Sentry.captureException(err, {
        level: transient ? 'warning' : 'error',
        fingerprint: ['takeit-fill-shap', alertType, 'write-failed'],
        tags: { 'takeit.alert_type': alertType },
        extra: { alertType, where: 'takeit-fill-shap.write', rows: ids.length },
      });
      return {
        status: transient ? 'partial' : 'error',
        scanned: rows.length,
        updated: 0,
        failed: rows.length,
        alreadyFilled: 0,
        reason: 'db_write_failed',
      };
    }
  }

  return {
    status: missing > 0 ? 'partial' : 'success',
    scanned: rows.length,
    updated,
    // A row the sidecar answered but the IS NULL guard skipped is already
    // filled: by another run, or by an earlier attempt of this UPDATE that
    // committed after withDbRetry's per-attempt timeout. Not a failure.
    failed: missing,
    alreadyFilled: ids.length - updated,
    ...(missing > 0 ? { reason: 'rows_missing' } : {}),
  };
}

async function takeitFillShapHandler(): Promise<CronResult> {
  // Checked once for the run, not per leg. Names only, never values.
  const url = process.env.SIDECAR_TAKEIT_URL;
  const secret = process.env.SIDECAR_TAKEIT_SECRET;
  if (!url || !secret) {
    const missing = [
      ...(url ? [] : ['SIDECAR_TAKEIT_URL']),
      ...(secret ? [] : ['SIDECAR_TAKEIT_SECRET']),
    ];
    Sentry.captureMessage('takeit.shap_fill.config_missing', {
      level: 'error',
      extra: { missing },
    });
    return {
      status: 'error',
      rows: 0,
      message: `config missing: ${missing.join(', ')}`,
      metadata: { missing },
    };
  }
  const sidecar = { url, secret };

  const lottery = await fillForAlertType('lottery', sidecar);
  const silentboom = await fillForAlertType('silentboom', sidecar);

  const unhealthy = [
    ['lottery', lottery],
    ['silentboom', silentboom],
  ] as const;
  const problems = unhealthy
    .filter(([, leg]) => leg.status !== 'success')
    .map(([name, leg]) => `${name}: ${leg.reason ?? leg.status}`);

  return {
    status: worstStatus(lottery.status, silentboom.status),
    rows: lottery.updated + silentboom.updated,
    ...(problems.length > 0 ? { message: problems.join('; ') } : {}),
    metadata: { lottery, silentboom },
  };
}

export default withCronInstrumentation(
  'takeit-fill-shap',
  takeitFillShapHandler,
  // No UW call: the only upstream is the Railway sidecar. The cron is
  // monitored, and a required-but-missing UW_API_KEY would 500 in cronGuard
  // before the check-in, paging a missed run for an unused dependency.
  { requireApiKey: false },
);
