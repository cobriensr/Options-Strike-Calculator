import * as Sentry from '@sentry/react';

/**
 * Capture an exception to Sentry, unless the error is a 401 or a 429 from a
 * fetch handler. A 401 is an expected guest-auth rejection per
 * project_auth_policy; a 429 is a limited client, which the server already
 * counts with `metrics.rateLimited`. Either would otherwise spam the
 * dashboard.
 *
 * Fetch handlers that want 401/429-suppression must tag the thrown error
 * with a numeric `status` property:
 *
 *   const error = new Error(...) as Error & { status?: number };
 *   error.status = res.status;
 *   throw error;
 *
 * Errors without a numeric `.status` (programming errors, parse
 * failures, network aborts, React render crashes) fall through to a
 * plain Sentry.captureException — so this is a safe drop-in
 * replacement at every existing capture site.
 */
export function captureUnlessAuth(
  error: unknown,
  options?: Parameters<typeof Sentry.captureException>[1],
): void {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const { status } = error as { status: unknown };
    if (status === 401 || status === 429) return;
  }
  Sentry.captureException(error, options);
}
