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

  /**
   * Custom error response payload. When present, called on the error path
   * to produce the JSON body sent to the client (status 500 default,
   * unless errorStatus is also provided). The default behavior emits
   * `{ job, error: 'Internal error' }` — pass this when the cron's
   * existing test contract pins a specific error key (e.g. fetch-flow's
   * `{ error: 'All sources failed' }`).
   *
   * Caller can include or exclude `job` themselves. If the callable
   * returns `{}` (empty object), the legacy default body is sent. The
   * `error` message is always included in the Axiom metadata regardless
   * of what this returns, so observability is preserved.
   */
  errorPayload?: (err: unknown, ctx: CronContext) => Record<string, unknown>;

  /**
   * Custom error response status code. Default 500. Pass this when the
   * cron returns 502 for upstream-API failure (e.g. fetch-darkpool when
   * UW is down, fetch-outcomes when the source feed is unreachable).
   */
  errorStatus?: (err: unknown) => number;

  /**
   * Dynamic time-gate that reads the request. Default behavior: the
   * static `timeCheck` option from cronGuard is used. When
   * `dynamicTimeCheck` is provided, the wrapper passes `req` to the
   * predicate so handlers can read query params (e.g. `?force=true` to
   * bypass a market-hours gate, `?backfill=true` to enable a historical
   * mode).
   *
   * Returns true → run the handler.
   * Returns false → skip with status 200 + `{ skipped: true, reason }`.
   *
   * Note: this composes WITH cronGuard's static timeCheck. cronGuard
   * runs first; if it allows the run, then `dynamicTimeCheck` is
   * evaluated. If `dynamicTimeCheck` returns `{ run: false }`, the
   * wrapper sends the skipped response and reports `status: 'skipped'`
   * to Axiom with the supplied `reason`.
   */
  dynamicTimeCheck?: (req: VercelRequest) => { run: boolean; reason: string };
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
    // Forward only cronGuard's recognized options — narrows the public
    // option surface and keeps wrapper-only options (errorPayload,
    // errorStatus, dynamicTimeCheck) out of the guard call. Build the
    // forwarded object incrementally so undefined keys don't show up in
    // call assertions.
    const guardOpts: {
      marketHours?: boolean;
      timeCheck?: () => boolean;
      requireApiKey?: boolean;
    } = {};
    if (opts.marketHours !== undefined)
      guardOpts.marketHours = opts.marketHours;
    if (opts.timeCheck !== undefined) guardOpts.timeCheck = opts.timeCheck;
    if (opts.requireApiKey !== undefined)
      guardOpts.requireApiKey = opts.requireApiKey;
    const guard = cronGuard(req, res, guardOpts);
    if (!guard) return;

    const startTimeMs = Date.now();
    Sentry.setTag('cron.job', jobName);

    const ctx: CronContext = {
      today: guard.today,
      apiKey: guard.apiKey,
      startTimeMs,
      logger,
    };

    // Composed with cronGuard's static gate. cronGuard runs first; only
    // if it allows the run do we evaluate the request-aware predicate.
    if (opts.dynamicTimeCheck) {
      const dyn = opts.dynamicTimeCheck(req);
      if (!dyn.run) {
        const durationMs = Date.now() - startTimeMs;
        try {
          await reportCronRun(jobName, {
            status: 'skipped',
            message: dyn.reason,
            durationMs,
          });
        } catch {
          /* swallowed: observability path must never crash the response */
        }
        res.status(200).json({
          job: jobName,
          status: 'skipped',
          message: dyn.reason,
          skipped: true,
          reason: dyn.reason,
          durationMs,
        });
        return;
      }
    }

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
      const errorMessage = err instanceof Error ? err.message : String(err);
      try {
        await reportCronRun(jobName, {
          status: 'error',
          message: errorMessage,
          error: errorMessage,
          durationMs,
        });
      } catch {
        /* swallowed: observability path must never crash the response */
      }

      const status = opts.errorStatus ? opts.errorStatus(err) : 500;
      const customBody = opts.errorPayload ? opts.errorPayload(err, ctx) : null;
      // Empty-object return is treated as "no override" so callers can
      // gate the override on err.kind without falling out of the API.
      const body =
        customBody && Object.keys(customBody).length > 0
          ? customBody
          : { job: jobName, error: 'Internal error' };
      res.status(status).json(body);
    }
  };
}
