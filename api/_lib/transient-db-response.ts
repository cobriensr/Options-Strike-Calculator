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
  /** Body to return on a genuine (non-transient) 500. */
  serverErrorBody: Record<string, unknown>;
}

/**
 * Map a caught error to the correct HTTP response.
 *
 * - Transient DB error → `503` `{ error, transient: true }` with a
 *   `Retry-After: 5` header. Logged at `warn`; a `<label>.db_timeout`
 *   counter is incremented. NOT sent to Sentry — infra blips are noise.
 * - Anything else → `500` with `serverErrorBody`, logged at `error`,
 *   and captured in Sentry.
 */
export function sendDbErrorResponse(
  res: VercelResponse,
  err: unknown,
  opts: SendDbErrorResponseOptions,
): void {
  const { label, serverErrorBody } = opts;

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
    return;
  }

  Sentry.captureException(err);
  logger.error({ err }, `${label} failed`);
  if (!res.headersSent) res.status(500).json(serverErrorBody);
}
