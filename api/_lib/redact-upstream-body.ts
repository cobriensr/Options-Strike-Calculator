/**
 * Make a third-party response body safe to put in an Error message, a log
 * line, or Sentry `extra`.
 *
 * Sentry's `beforeSend` (api/_lib/sentry.ts) scrubs by KEY name only, so a
 * token echoed inside a body string would sail through. This masks every
 * run of 24+ token-alphabet characters (base64 / base64url / hex / JWT:
 * `A-Za-z0-9+/=_.-`) as `[redacted]`, THEN truncates to 200 characters —
 * masking first means a token straddling the cut can't leave a fragment.
 * Ordinary error JSON survives: its keys and messages are short words or
 * space-separated text (e.g. Schwab's `invalid_grant` stays readable).
 */

const TOKEN_LIKE_RUN = /[A-Za-z0-9+/=_.-]{24,}/g;
const MAX_LENGTH = 200;

export function redactUpstreamBody(body: string): string {
  const masked = body.replaceAll(TOKEN_LIKE_RUN, '[redacted]');
  if (masked.length <= MAX_LENGTH) return masked;
  return `${masked.slice(0, MAX_LENGTH)}… (${body.length} chars)`;
}
