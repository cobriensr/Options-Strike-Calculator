import * as Sentry from '@sentry/react';

/**
 * Capture an exception to Sentry, unless the error is a 401 from a
 * fetch handler — those are expected guest-auth rejections per
 * project_auth_policy and would otherwise spam the dashboard.
 *
 * Fetch handlers that want 401-suppression must tag the thrown error
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
  if (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status: unknown }).status === 401
  ) {
    return;
  }
  Sentry.captureException(error, options);
}
