/**
 * Shared error-response helper for read endpoints that hit Neon.
 *
 * When a query trips `withDbRetry`'s per-attempt timeout (the
 * `db attempt timeout` error) or any other transient Neon blip
 * (`fetch failed`, `recovery_mode`, `Too many connections`, etc.),
 * the endpoint should degrade gracefully — a soft, auto-retrying
 * `503` instead of a hard `500` error card — and NOT spam Sentry with
 * infra-blip exceptions. Genuine (non-retryable) errors still surface
 * as `500` and are captured in Sentry for triage.
 *
 * See docs/superpowers/specs/transient-db-degrade-2026-06-09.md.
 */

import type { VercelResponse } from '@vercel/node';

import { TransientDbError } from './db.js';
import logger from './logger.js';
import { Sentry, metrics } from './sentry.js';

interface SendDbErrorResponseOptions {
  /** Telemetry label, e.g. `greek_heatmap`. Used in log + metric keys. */
  label: string;
  /**
   * Body to return on a genuine (non-transient) 500. Optional —
   * defaults to `{ error: 'Internal error' }` so callers that have no
   * special body don't have to repeat the boilerplate.
   */
  serverErrorBody?: Record<string, unknown>;
  /**
   * The request-metric callback returned by `metrics.request(route)`.
   * When provided, the helper invokes it with the status it actually
   * sent (`503` for a transient blip, `500` for a genuine error) so the
   * recorded `api.request` status matches the real response. Without
   * this, callers had to guess `done({ status: 500 })` BEFORE the helper
   * ran — which mis-records a transient blip as a 500. Optional and
   * backward-compatible: callers that still record their own status can
   * omit it.
   */
  done?: (opts: { status: number }) => void;
}

const DEFAULT_SERVER_ERROR_BODY: Record<string, unknown> = {
  error: 'Internal error',
};

/**
 * Map a caught error to the correct HTTP response.
 *
 * - Transient DB error → `503` `{ error, transient: true }` with a
 *   `Retry-After: 5` header. Logged at `warn`; a `<label>.db_timeout`
 *   counter is incremented. NOT sent to Sentry — infra blips are noise.
 *   `done?.({ status: 503 })` is called so the request metric records the
 *   blip as a 503, not a 500.
 * - Anything else → `500` with `serverErrorBody` (default
 *   `{ error: 'Internal error' }`), logged at `error`, and captured in
 *   Sentry. `done?.({ status: 500 })` is called.
 *
 * @returns the HTTP status actually sent — `503` for a transient blip,
 *   `500` for a genuine error. Safe to ignore.
 */
export function sendDbErrorResponse(
  res: VercelResponse,
  err: unknown,
  opts: SendDbErrorResponseOptions,
): number {
  const { label, serverErrorBody = DEFAULT_SERVER_ERROR_BODY, done } = opts;

  // Telemetry runs BEFORE any response write so it fires even when the
  // response was already partially committed (headersSent guard below).
  if (err instanceof TransientDbError) {
    logger.warn({ err }, `${label} transient db timeout`);
    metrics.increment(`${label}.db_timeout`);
    if (!res.headersSent) {
      res.setHeader('Retry-After', '5');
      res
        .status(503)
        .json({ error: 'temporarily unavailable', transient: true });
    }
    done?.({ status: 503 });
    return 503;
  }

  Sentry.captureException(err);
  logger.error({ err }, `${label} failed`);
  if (!res.headersSent) res.status(500).json(serverErrorBody);
  done?.({ status: 500 });
  return 500;
}
