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

import { randomUUID, timingSafeEqual } from 'node:crypto';

import { waitUntil } from '@vercel/functions';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import logger from './logger.js';
import { Sentry } from './sentry.js';
import { cronGuard } from './api-helpers.js';
import { reportCronRun } from './axiom.js';
import { SCHEDULE_MAP, type CronMonitorConfig } from './cron-schedules.js';

// ============================================================
// DIRECT SENTRY CHECK-IN HTTP CLIENT
// ============================================================
//
// `Sentry.captureCheckIn()` (and `Sentry.withMonitor()` which calls it
// twice under the hood) is fire-and-forget at the SDK level. The
// completion check-in is queued, the function returns, the queue
// drain happens via the SDK's transport — and on Vercel Fluid Compute
// the runtime can kill the in-flight HTTP request before it reaches
// Sentry's wire. We tried `await Sentry.flush()` (commit 449fa949) and
// `waitUntil(Sentry.flush())` (commit e6db3d3d); both helped, neither
// reliably. Recovery check-ins only landed ~70% of the time, leaving
// monitors firing "A timeout check-in detected" issues every minute.
//
// This bypass talks to Sentry's check-in ingest endpoint directly via
// `await fetch()`. The await blocks until the HTTP response actually
// arrives — no SDK queue, no flush, no Vercel exit race. Deterministic.
//
// Endpoint reference: https://docs.sentry.io/api/crons/

interface SentryDsnParts {
  /** The DSN's public key — used in the ingest URL path. */
  publicKey: string;
  /** Ingest host, e.g. `o12345.ingest.us.sentry.io`. */
  ingestHost: string;
  /** Numeric project id from the DSN path. */
  projectId: string;
}

let cachedDsn: SentryDsnParts | null | undefined;

/**
 * Parse `SENTRY_DSN` into the ingest parts needed for Sentry's Crons
 * HTTP API. Returns `null` when DSN is missing or malformed — caller
 * must treat this as "no monitor signal" and skip the check-in.
 *
 * DSN shape: `https://<publicKey>@<host>/<projectId>`. The host is the
 * org ingest subdomain on modern projects (e.g.
 * `o12345.ingest.us.sentry.io`) and a plain `sentry.io` on legacy ones.
 * Both work — `URL` parsing handles either.
 */
function getDsnParts(): SentryDsnParts | null {
  if (cachedDsn !== undefined) return cachedDsn;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    cachedDsn = null;
    return null;
  }
  try {
    const url = new URL(dsn);
    // Assumption: project id is a single path segment immediately after
    // the host (hosted Sentry shape). Self-hosted deployments at a
    // subpath like `https://key@host/relay/123` would mis-parse this —
    // we'd send the URL with `relay/123` as the project id and Sentry
    // would 404. Not a concern for the hosted DSN this project uses.
    const projectId = url.pathname.replace(/^\/+/, '');
    if (!url.username || !url.host || !projectId) {
      cachedDsn = null;
      return null;
    }
    cachedDsn = {
      publicKey: url.username,
      ingestHost: url.host,
      projectId,
    };
  } catch {
    cachedDsn = null;
  }
  return cachedDsn;
}

/**
 * Test-only reset of the parsed-DSN cache. Tests that vary
 * `process.env.SENTRY_DSN` between cases must call this in `beforeEach`
 * so the next `getDsnParts()` call re-reads the env. Production code
 * never calls this — the singleton cache is correct there because the
 * DSN is fixed for a function's lifetime.
 */
export function _resetDsnCacheForTest(): void {
  cachedDsn = undefined;
}

/** Sentry Crons API monitor_config payload (snake_case, per the spec). */
interface SentryMonitorConfigPayload {
  schedule: { type: 'crontab'; value: string };
  checkin_margin: number;
  max_runtime: number;
  failure_issue_threshold: number;
  recovery_threshold: number;
  timezone: 'UTC';
}

function toMonitorConfigPayload(
  c: CronMonitorConfig,
): SentryMonitorConfigPayload {
  return {
    schedule: { type: 'crontab', value: c.schedule },
    checkin_margin: c.checkinMargin,
    max_runtime: c.maxRuntime,
    failure_issue_threshold: c.failureIssueThreshold ?? 1,
    recovery_threshold: c.recoveryThreshold ?? 1,
    timezone: 'UTC',
  };
}

interface SentryCheckInInput {
  monitorSlug: string;
  status: 'in_progress' | 'ok' | 'error';
  /** Required for `ok`/`error`; omit for the first `in_progress`. */
  checkInId?: string;
  /** Job duration in seconds (only for `ok` / `error`). */
  duration?: number;
  /** Upsert the monitor config on the first `in_progress`. */
  monitorConfig?: CronMonitorConfig;
}

/**
 * POST a single check-in to Sentry's Crons ingest endpoint via direct
 * `fetch()`. Returns the check-in id (either the one passed in or a
 * freshly minted UUID for the initial `in_progress`).
 *
 * Always resolves — network errors, DSN parsing failures, and non-2xx
 * responses are swallowed. The caller never gets back a useful
 * "was it delivered?" signal; that's by design (observability paths
 * must never crash the response). What we DO get is "the await blocks
 * until the HTTP request actually returns" — which is the entire
 * reason this bypass exists vs. the SDK's queue-and-flush dance.
 *
 * 5s timeout on the fetch so a slow Sentry can't stretch the function
 * beyond its budget. Even on `error` the cron itself still completes
 * — Sentry will only see the in_progress and fire a `maxRuntime`
 * alert, which is the failure mode we're trying to fix in the first
 * place; but better than blocking the response indefinitely.
 */
async function sentryCheckInDirect(input: SentryCheckInInput): Promise<string> {
  const checkInId = input.checkInId ?? randomUUID();
  const dsn = getDsnParts();
  if (!dsn) return checkInId;

  const url =
    `https://${dsn.ingestHost}/api/${dsn.projectId}/cron/` +
    `${encodeURIComponent(input.monitorSlug)}/${dsn.publicKey}/`;

  const body: Record<string, unknown> = {
    check_in_id: checkInId,
    monitor_slug: input.monitorSlug,
    status: input.status,
    environment: process.env.VERCEL_ENV ?? 'production',
  };
  if (input.duration != null) body.duration = input.duration;
  if (input.monitorConfig) {
    body.monitor_config = toMonitorConfigPayload(input.monitorConfig);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    // We deliberately use Node's default keep-alive pool here. Tried
    // `Connection: close` in commit 62365e9e to eliminate stale-conn
    // drops, but production showed the opposite: forcing a fresh TLS
    // handshake per check-in produced ~100% miss rate (verified via
    // Vercel runtime logs showing all handlers returning 200 while
    // Sentry recorded "timeout check-in detected" every minute). Most
    // likely Sentry's ingest edge throttles or RSTs unrecognized TLS
    // sessions under burst. Keep-alive reuse is the lesser evil: the
    // ~5% miss rate from stale-pool drops is silenced by the
    // failureIssueThreshold: 3 policy in SCHEDULE_MAP.
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    // Sentry's Crons ingest returns 202 Accepted on success. A 4xx here
    // typically means a bad DSN, project mismatch, or rate-limit; a 5xx
    // means Sentry is down. Either way we still swallow (observability
    // must never crash the response), but we log so the next "timeouts
    // are firing again" investigation can immediately see whether the
    // check-in itself was rejected vs. some other layer breaking.
    if (!response.ok) {
      logger.warn(
        {
          monitorSlug: input.monitorSlug,
          status: input.status,
          httpStatus: response.status,
        },
        'sentry check-in rejected',
      );
    }
  } catch {
    /* swallowed: observability path must never crash the response */
  } finally {
    clearTimeout(timer);
  }
  return checkInId;
}

/**
 * Constant-time check of the `Authorization: Bearer <CRON_SECRET>` header.
 * Returns false when CRON_SECRET is unset or the header is missing/wrong.
 *
 * Used by `withCronCheckin` to short-circuit Sentry check-ins for
 * unauthenticated traffic (bot scans, misrouted requests). Mirrors the
 * auth check in `cronGuard()` — the duplication is deliberate: this
 * decision must be made BEFORE the wrapper sends its `in_progress`
 * check-in, which is before cronGuard runs inside the inner handler.
 */
export function isCronAuthenticated(req: VercelRequest): boolean {
  const cronSecret = process.env.CRON_SECRET ?? '';
  if (cronSecret.length === 0) return false;
  const authHeader = req.headers.authorization ?? '';
  const expected = `Bearer ${cronSecret}`;
  const authBuf = Buffer.from(authHeader);
  const expBuf = Buffer.from(expected);
  if (authBuf.length !== expBuf.length) return false;
  return timingSafeEqual(authBuf, expBuf);
}

/**
 * Hand Sentry's outbound queue to Vercel via `waitUntil()` so the flush
 * can drain AFTER the response is sent, instead of being killed when
 * the Vercel Function exits.
 *
 * Why not `await Sentry.flush()`: tried that in commit 449fa949 and it
 * had zero effect — `monitor-flow-ratio`, `monitor-vega-spike`, and
 * friends kept firing "A timeout check-in detected" every minute after
 * deploy. The function-exit pattern (`await flush; return`) doesn't
 * keep the in-flight HTTP request alive on Fluid Compute the way it
 * does on a traditional Node server. `waitUntil()` is Vercel's
 * documented pattern for post-response work — it registers the promise
 * with the runtime so the instance stays alive specifically to drain
 * pending background promises, even after `res.end()`.
 *
 * `captureCheckIn` and `captureException` are fire-and-forget at the
 * SDK level; without this helper, the completion check-in for a cron
 * never reaches Sentry's wire and the monitor stays stuck on
 * `in_progress` until `maxRuntime` expires.
 *
 * `Sentry.withMonitor()` does NOT flush internally either (verified
 * against `@sentry/core/build/cjs/exports.js` — under the hood it's
 * two fire-and-forget `captureCheckIn` calls). So this helper is needed
 * everywhere a check-in is sent right before function exit, in both
 * wrappers below.
 *
 * 2s matches the Sentry-docs default for serverless graceful shutdown.
 * No-op when `Sentry.flush` is unavailable (per-test mocks that stub a
 * narrow surface). Errors on the flush promise are swallowed by the
 * `.catch` so `waitUntil` never sees a rejection — observability paths
 * must never crash the response.
 */
function flushSentry(): void {
  if (typeof Sentry.flush !== 'function') return;
  try {
    waitUntil(
      Sentry.flush(2000).catch(() => {
        /* swallowed: observability path must never crash the response */
      }),
    );
  } catch {
    /* swallowed: waitUntil itself can throw outside a Vercel runtime */
  }
}

/**
 * Send a single `ok` check-in to Sentry for the given monitor. Used when
 * the cron is intentionally skipped (outside market hours, weekend,
 * holiday) so Sentry's missed-checkin signal stays accurate — without
 * this, every minute of the post-close window in vercel.json's
 * `* 13-21 * * 1-5` schedule alerts as a missed check-in even though
 * the skip is by design.
 *
 * Uses the direct HTTP bypass (see `sentryCheckInDirect`) so the
 * check-in actually leaves the function before Vercel kills the
 * runtime. No-op when the job has no SCHEDULE_MAP entry (new cron not
 * yet registered).
 */
async function sendIntentionalSkipCheckin(jobName: string): Promise<void> {
  const config = SCHEDULE_MAP[jobName];
  if (!config) return;
  await sentryCheckInDirect({
    monitorSlug: jobName,
    status: 'ok',
    monitorConfig: config,
  });
}

/**
 * Context handed to the cron logic. `today` and `apiKey` come from
 * `cronGuard()`; `startTimeMs` is captured at wrapper entry; `logger` is
 * the shared pino logger so call sites can rely on a single import.
 *
 * `req` is the raw VercelRequest. It is intentionally only populated
 * when the handler opts in via `passReq: true` so the default surface
 * stays narrow — most crons should derive everything from `today` /
 * `apiKey` and never read query params. Handlers that DO need it (e.g.
 * `?backfill=true`, `?date=YYYY-MM-DD`) opt in explicitly. The field is
 * typed always-optional rather than via a generic
 * `CronContext<P extends boolean>` because (1) the codebase's
 * `exactOptionalPropertyTypes` policy treats `foo?: T` as
 * "absent-or-undefined" coalesced and (2) a generic would propagate
 * through every handler signature, exported type, and test — high TS
 * churn for marginal type-safety gain. The pattern mirrors how
 * `apiKey` handles `requireApiKey: false` (always typed string,
 * empty when absent).
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
  /**
   * Raw VercelRequest. Populated only when `passReq: true` is set on
   * the wrapper options. Handlers that did not opt in will see
   * `undefined` here.
   */
  req?: VercelRequest;
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
   * Expose the raw VercelRequest on `CronContext.req`. Default: false.
   *
   * Opt-in escape hatch for the small number of handlers that need to
   * read query params or headers from inside their business logic
   * (e.g. `?backfill=true`, `?date=YYYY-MM-DD`). CronContext
   * intentionally hides `req` so handlers don't accidentally couple to
   * the Vercel request shape — passing `passReq: true` is the
   * documented way to break that invariant when the alternative would
   * be a module-scoped `currentReq` ref + dispatcher (which works
   * today only because JS is single-threaded; any future `await`
   * before the read silently breaks it).
   *
   * Prefer `dynamicTimeCheck` for time-gate decisions — `passReq` is
   * for crons whose date-list selection or statement_timeout tuning
   * also depends on the request.
   */
  passReq?: boolean;

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
    if (!guard) {
      // Intentional skip (status 200, e.g. outside market hours) → tell
      // Sentry the cron checked in. Real auth/config failures (4xx/5xx)
      // get NO check-in so the missed-checkin signal still alerts on
      // genuine outages.
      if (res.statusCode === 200) {
        await sendIntentionalSkipCheckin(jobName);
      }
      return;
    }

    const startTimeMs = Date.now();
    Sentry.setTag('cron.job', jobName);

    const ctx: CronContext = {
      today: guard.today,
      apiKey: guard.apiKey,
      startTimeMs,
      logger,
      ...(opts.passReq ? { req } : {}),
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

    // Sentry Cron Monitor via the direct HTTP bypass. We used to wrap
    // the handler in `Sentry.withMonitor()` which calls `captureCheckIn`
    // twice fire-and-forget — that path lost ~30% of completion
    // check-ins on Vercel Fluid Compute because the SDK queue didn't
    // drain before the function exited (commits 449fa949 + e6db3d3d
    // tried `await flush` then `waitUntil(flush)`, both partial). Now
    // we POST to Sentry's Crons ingest endpoint directly and `await`
    // the response — deterministic, no queue, no flush race.
    //
    // Side effect of dropping `Sentry.withMonitor()`: we no longer get
    // the `withIsolationScope` wrap around the handler. Each cron runs
    // in a fresh Vercel Function invocation, so the scope is already
    // isolated at the runtime level — losing the SDK-level wrap is a
    // no-op for breadcrumbs/tags in this codebase.
    //
    // Jobs without a SCHEDULE_MAP entry run un-monitored (handler still
    // runs, reportCronRun still emits Axiom events — we just lose the
    // Sentry missed-checkin signal for that one invocation). This keeps
    // the wrapper safe for new crons added before the schedule map is
    // updated; cron-schedules.test.ts catches stale entries the other
    // direction. See docs/superpowers/specs/sentry-monitoring-2026-05-07.md.
    const monitorConfig = SCHEDULE_MAP[jobName];

    const checkInId = monitorConfig
      ? await sentryCheckInDirect({
          monitorSlug: jobName,
          status: 'in_progress',
          monitorConfig,
        })
      : null;

    try {
      const result = await handler(ctx);
      const durationMs = Date.now() - startTimeMs;

      if (monitorConfig && checkInId) {
        await sentryCheckInDirect({
          monitorSlug: jobName,
          status: 'ok',
          checkInId,
          duration: durationMs / 1000,
        });
      }

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
      flushSentry();
    } catch (err) {
      const durationMs = Date.now() - startTimeMs;

      if (monitorConfig && checkInId) {
        await sentryCheckInDirect({
          monitorSlug: jobName,
          status: 'error',
          checkInId,
          duration: durationMs / 1000,
        });
      }

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
      flushSentry();
    }
  };
}

/**
 * Lighter-weight cron monitor wrap for handlers that can't adopt the
 * full `withCronInstrumentation` (paginated handlers, NDJSON streamers,
 * non-standard return shapes — see Phase 3 of the spec).
 *
 * Behaviour:
 *   1. Read `SCHEDULE_MAP[jobName]`. If missing OR
 *      `Sentry.captureCheckIn` is unavailable (per-test mocks), run the
 *      handler unchanged.
 *   2. Send `in_progress` check-in BEFORE the handler so missed-checkin
 *      detection fires when the function never executes.
 *   3. After the handler completes, look at `res.statusCode` to decide
 *      `ok` vs `error`. This is the deliberate trade-off: handlers that
 *      catch their own errors and respond 500 still get an `error`
 *      check-in even though no exception bubbled to the wrapper.
 *   4. If the handler throws (rare — most handlers catch internally),
 *      send `error` check-in then re-throw. The throw will surface to
 *      Vercel runtime as an unhandled rejection unless the handler does
 *      its own outer try/catch, which is consistent with the existing
 *      handler contract.
 *
 * This wrapper does NOT touch reportCronRun, the response shape, the
 * cronGuard call, or any other handler-internal concerns. It is purely
 * additive observability.
 *
 * Spec: docs/superpowers/specs/sentry-monitoring-2026-05-07.md
 */
export function withCronCheckin(
  jobName: string,
  // Permissive return type: handlers commonly `return res.status(N).json(...)`
  // which yields VercelResponse; we don't read the value, so accept any.
  inner: (req: VercelRequest, res: VercelResponse) => Promise<unknown>,
): (req: VercelRequest, res: VercelResponse) => Promise<void> {
  return async function checkedCron(
    req: VercelRequest,
    res: VercelResponse,
  ): Promise<void> {
    const config = SCHEDULE_MAP[jobName];

    if (!config) {
      // No schedule registered (new cron not yet in SCHEDULE_MAP) →
      // run un-monitored. Matches the prior behaviour where the
      // wrapper short-circuited on a missing config.
      await inner(req, res);
      return;
    }

    // Skip Sentry check-ins for unauthenticated requests. Bot scans and
    // misrouted traffic that hit `/api/cron/<job>` without a valid Bearer
    // get a clean 401 from cronGuard inside `inner()`, but without this
    // gate the wrapper would still register `in_progress` then `error`
    // (because res.statusCode >= 400), creating a Sentry monitor incident
    // from non-cron traffic. Real Vercel cron invocations always carry
    // the matching Bearer header so they pass straight through.
    if (!isCronAuthenticated(req)) {
      await inner(req, res);
      return;
    }

    const startMs = Date.now();
    const checkInId = await sentryCheckInDirect({
      monitorSlug: jobName,
      status: 'in_progress',
      monitorConfig: config,
    });

    try {
      await inner(req, res);
      const status: 'ok' | 'error' = res.statusCode >= 400 ? 'error' : 'ok';
      await sentryCheckInDirect({
        monitorSlug: jobName,
        status,
        checkInId,
        duration: (Date.now() - startMs) / 1000,
      });
    } catch (err) {
      await sentryCheckInDirect({
        monitorSlug: jobName,
        status: 'error',
        checkInId,
        duration: (Date.now() - startMs) / 1000,
      });
      throw err;
    }
  };
}
