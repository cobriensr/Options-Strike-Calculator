/**
 * withCronInstrumentation — HOF that wraps the boilerplate every cron
 * handler ends with: cronGuard preamble + Sentry tag + captureException
 * + reportCronRun + duration tracking + standardized response shape.
 *
 * The shape was extracted from a parallel-agent assessment of the 30+
 * cron handlers in `api/cron/`. ~38/49 cron handlers end with verbatim
 * variations of:
 *
 *   try { ...handler logic; await reportCronRun(name, { status, ... }); }
 *   catch (err) {
 *     Sentry.setTag('cron.job', name);
 *     Sentry.captureException(err);
 *     logger.error({ err }, '<name> error');
 *     return res.status(500).json({ error: 'Internal error' });
 *   }
 *
 * Adoption is staged across multiple Phase 3a sub-batches so each batch
 * stays under the 5-file budget. This module is greenfield — adoption
 * sites are NOT touched here.
 *
 * Phase 1a of docs/superpowers/specs/api-refactor-2026-05-02.md
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import logger from './logger.js';
import { Sentry } from './sentry.js';
import { cronGuard } from './api-helpers.js';
import { reportCronRun } from './axiom.js';

/**
 * Context handed to the cron logic. `today` and `apiKey` come from
 * `cronGuard()`; `startTimeMs` is captured at wrapper entry; `logger` is
 * the shared pino logger so call sites can rely on a single import.
 */
export interface CronContext {
  /** ET-localized YYYY-MM-DD date string. */
  today: string;
  /** UW_API_KEY value (empty string when `requireApiKey: false`). */
  apiKey: string;
  /** Wall-clock start timestamp in ms (from `Date.now()` at wrap entry). */
  startTimeMs: number;
  /** Shared pino logger (re-exported so handlers don't need a separate import). */
  logger: typeof logger;
}

/**
 * Result returned by the wrapped handler. Status maps directly to the
 * Axiom domain event so dashboards stay consistent across the fleet.
 *
 *   - 'success' — the cron did its job. Includes 'ok' callers historically
 *     used; we standardize on 'success' going forward.
 *   - 'partial' — some sub-units succeeded, others failed. Caller should
 *     populate `metadata.failureCount` etc. for downstream filtering.
 *   - 'skipped' — the cron deliberately did nothing (no work to do, no
 *     new data, etc.). Not an error condition.
 *   - 'error'   — caller-detected error path. Distinct from a thrown
 *     exception (which the wrapper itself reports as `status: 'error'`
 *     with the captured exception attached).
 */
export type CronStatus = 'success' | 'partial' | 'error' | 'skipped';

export interface CronResult {
  /** Outcome bucket sent to Axiom and the response body. */
  status: CronStatus;
  /** Optional row count for upsert-style crons. */
  rows?: number;
  /** Optional human-readable reason (e.g. "no new trades"). */
  message?: string;
  /** Optional structured metadata; merged into the Axiom payload. */
  metadata?: Record<string, unknown>;
}

/**
 * Options forwarded to the underlying `cronGuard()` call.
 *
 * Intentionally narrow — handlers that need finer-grained control (like
 * `fetch-market-internals` setting `requireApiKey: false`) can pass it
 * through here without re-implementing the guard.
 */
export interface WithCronInstrumentationOptions {
  /** Skip the isMarketHours() check. Default: gate enabled. */
  marketHours?: boolean;
  /** Custom time-window predicate. Overrides marketHours when provided. */
  timeCheck?: () => boolean;
  /** Require `UW_API_KEY`. Default: true. */
  requireApiKey?: boolean;
}

/**
 * Wrap a cron handler so the calling site only writes its job-specific
 * logic, returning a `CronResult`. The wrapper handles:
 *
 *   1. `cronGuard(req, res)` — auth + time window + API key. Returns the
 *      standard non-running response automatically when the guard fails.
 *   2. Sentry tag scoping (`cron.job` set once for any captured exceptions).
 *   3. Try/catch around the handler:
 *        - success path: `reportCronRun(name, { status, rows?, message?, durationMs, ...metadata })`
 *          and a 200 JSON response with the same fields.
 *        - exception path: `Sentry.captureException(err)`, an error log
 *          with the duration, `reportCronRun` with `status: 'error'`,
 *          and a 500 JSON response.
 *   4. Duration tracking (closes the loop on observability for every job).
 */
export function withCronInstrumentation(
  jobName: string,
  handler: (ctx: CronContext) => Promise<CronResult>,
  opts: WithCronInstrumentationOptions = {},
): (req: VercelRequest, res: VercelResponse) => Promise<void> {
  return async function instrumentedCron(
    req: VercelRequest,
    res: VercelResponse,
  ): Promise<void> {
    const guard = cronGuard(req, res, opts);
    if (!guard) return;

    const startTimeMs = Date.now();
    Sentry.setTag('cron.job', jobName);

    const ctx: CronContext = {
      today: guard.today,
      apiKey: guard.apiKey,
      startTimeMs,
      logger,
    };

    try {
      const result = await handler(ctx);
      const durationMs = Date.now() - startTimeMs;

      await reportCronRun(jobName, {
        status: result.status,
        ...(result.rows != null ? { rows: result.rows } : {}),
        ...(result.message != null ? { message: result.message } : {}),
        ...(result.metadata ?? {}),
        durationMs,
      });

      res.status(200).json({
        job: jobName,
        status: result.status,
        ...(result.rows != null ? { rows: result.rows } : {}),
        ...(result.message != null ? { message: result.message } : {}),
        ...(result.metadata ?? {}),
        durationMs,
      });
    } catch (err) {
      const durationMs = Date.now() - startTimeMs;
      Sentry.captureException(err);
      logger.error({ err, durationMs }, `${jobName} error`);

      // reportCronRun never throws — it swallows errors internally — but
      // we still wrap defensively so a downstream rewrite can't break the
      // 500 response path.
      //
      // Backward-compat alias: pre-wrapper handlers wrote `error: <msg>` to
      // Axiom metadata. We emit BOTH `error` and `message` so existing
      // dashboards keyed on either field keep working post-adoption.
      try {
        const errorMessage = err instanceof Error ? err.message : String(err);
        await reportCronRun(jobName, {
          status: 'error',
          message: errorMessage,
          error: errorMessage,
          durationMs,
        });
      } catch {
        /* swallowed: observability path must never crash the response */
      }

      res.status(500).json({ job: jobName, error: 'Internal error' });
    }
  };
}
