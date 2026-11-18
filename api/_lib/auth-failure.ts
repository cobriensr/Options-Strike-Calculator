/**
 * Report a failed machine-secret check: the cron routes (`cronGuard`), the
 * internal push route (`/api/push/notify`) and the plot-analysis route
 * (`/api/ml/analyze-plots`).
 *
 * Each of those answers 401 and, before this, said nothing else, so a secret
 * that one side had not picked up looked the same as no traffic.
 * `reportSecretMismatch` makes every failure visible:
 *
 * - a counter (`auth.secret_mismatch`, tagged with the surface) and one
 *   structured log line, for every mismatch;
 * - one Sentry message per surface per 10 minutes, so a burst of failed
 *   requests opens one issue per surface rather than one event per request. The
 *   issue is tagged with the surface, since the fingerprint is not shown, and
 *   with a `reason`: `missing` when the surface's credential header was empty
 *   or absent (a caller that sent nothing), `wrong` when one came and did not
 *   match (a secret one side has not picked up).
 *
 * What is reported is the surface, the path (no query string, cut at
 * `MAX_LOGGED_PATH` characters), the client address and whether the surface's
 * own credential header was present at all.
 * Never a header value, a cookie, a query value, or any length.
 *
 * Imports only the client-address, logger and Sentry modules, never
 * auth-helpers, api-helpers or guest-auth: `cron-helpers.ts` imports this file,
 * and the cron path must not pull in auth-helpers' botid and Redis imports
 * (same reason as secret-compare.ts and secret-strength.ts).
 */

import type { VercelRequest } from '@vercel/node';

import { rateLimitIp } from './client-ip.js';
import logger from './logger.js';
import { Sentry, metrics } from './sentry.js';

export type SecretSurface = 'cron' | 'notify' | 'analyze-plots';

/** The header each surface reads its credential from. */
const CREDENTIAL_HEADER: Record<SecretSurface, string> = {
  cron: 'authorization',
  notify: 'x-internal-notify-secret',
  'analyze-plots': 'authorization',
};

// The Sentry alert rule "Auth: wrong secret, short secret or guest-key limit"
// matches messages that start with this text; reword it and update the rule.
const MESSAGE = 'Secret check failed';

/** Shortest gap between two Sentry messages for one surface. */
const SENTRY_INTERVAL_MS = 10 * 60 * 1000;

/** Longest path written to the log, so one request cannot bloat a line. */
const MAX_LOGGED_PATH = 200;

// When each surface last sent its Sentry message. The key is the closed
// `SecretSurface` union, never anything from a request, so it holds at most
// three entries.
const lastSentryAt = new Map<SecretSurface, number>();

/** The request path with any query string removed, cut at the log limit. */
function pathOf(req: VercelRequest): string {
  const url = req.url ?? '';
  const queryAt = url.indexOf('?');
  const path = queryAt === -1 ? url : url.slice(0, queryAt);
  return path.slice(0, MAX_LOGGED_PATH);
}

/** Whether the surface's own credential header held anything. */
function hadCredential(surface: SecretSurface, req: VercelRequest): boolean {
  const value = req.headers[CREDENTIAL_HEADER[surface]];
  return Boolean(Array.isArray(value) ? value[0] : value);
}

function clientIp(req: VercelRequest): string {
  const value = req.headers['x-real-ip'];
  return rateLimitIp(Array.isArray(value) ? value[0] : value);
}

/**
 * Count and log one failed secret check, and send the surface's Sentry message
 * unless it sent one in the last 10 minutes. Call it once per request, at the
 * place the surface sends its 401.
 *
 * The send time is recorded before the message goes out, so a Sentry that
 * throws costs that one call and no later one inside the window: the guards
 * call this on every rejected request, and a throw on each would turn every
 * 401 into a 500.
 */
export function reportSecretMismatch(
  surface: SecretSurface,
  req: VercelRequest,
): void {
  metrics.secretMismatch(surface);
  logger.warn(
    {
      surface,
      path: pathOf(req),
      ip: clientIp(req),
      hadCredential: hadCredential(surface, req),
    },
    MESSAGE,
  );

  const now = Date.now();
  const last = lastSentryAt.get(surface);
  if (last !== undefined && now - last < SENTRY_INTERVAL_MS) return;
  lastSentryAt.set(surface, now);
  Sentry.captureMessage(MESSAGE, {
    level: 'warning',
    fingerprint: ['secret-mismatch', surface],
    tags: {
      surface,
      reason: hadCredential(surface, req) ? 'wrong' : 'missing',
    },
  });
}
