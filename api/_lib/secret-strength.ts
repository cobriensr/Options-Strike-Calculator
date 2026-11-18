/**
 * Warn-only check for configured secrets that are shorter than the minimum.
 *
 * `isOwner` (the request path) and `cronGuard` (the cron path) both call
 * `warnWeakSecretsOnce`, which looks at the configuration once per instance
 * and reports any short secret by name through the logger and one Sentry
 * message. Nothing here changes how a secret is compared or what a guard
 * accepts: a short secret keeps working until it is replaced.
 *
 * What is reported is the variable's name and, for a guest key, its position
 * in the list. Never a value, a prefix, or a length.
 *
 * Imports only the logger and Sentry modules, never auth-helpers,
 * api-helpers or guest-auth: `cron-helpers.ts` imports this file, and the
 * cron path must not pull in auth-helpers' botid and Redis imports (same
 * reason as secret-compare.ts).
 */

import logger from './logger.js';
import { Sentry } from './sentry.js';

/** Shortest accepted length of the owner, cron and internal-notify secrets. */
export const MIN_SECRET_LEN = 32;

/** Shortest accepted length of one configured guest key. */
export const MIN_GUEST_KEY_LEN = 24;

const CHECKED_SECRETS = [
  'OWNER_SECRET',
  'CRON_SECRET',
  'INTERNAL_NOTIFY_SECRET',
] as const;

const WARNING_MESSAGE = 'Configured secret shorter than the minimum';

/**
 * Names of the configured secrets that are shorter than their minimum, read
 * from `process.env`: `OWNER_SECRET`, `CRON_SECRET` and
 * `INTERNAL_NOTIFY_SECRET` under `MIN_SECRET_LEN`, then
 * `GUEST_ACCESS_KEYS[<index>]` for each key under `MIN_GUEST_KEY_LEN` after
 * trimming. An unset or empty variable is not reported.
 *
 * The guest list is parsed here (split on `,`, trim, drop empty entries) and
 * `<index>` is the position among the non-empty entries. It does not reuse
 * `getConfiguredGuestKeys`, which sits behind auth-helpers and drops keys
 * under 8 bytes: those must still be reported.
 */
export function weakSecretNames(): string[] {
  const names: string[] = [];

  for (const name of CHECKED_SECRETS) {
    const value = process.env[name];
    if (value && value.length < MIN_SECRET_LEN) names.push(name);
  }

  const guestKeys = (process.env.GUEST_ACCESS_KEYS ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
  guestKeys.forEach((key, index) => {
    if (key.length < MIN_GUEST_KEY_LEN) {
      names.push(`GUEST_ACCESS_KEYS[${index}]`);
    }
  });

  return names;
}

// Set on the first evaluation, whatever it finds: the environment does not
// change while an instance lives, so every later call is one boolean read.
// A boolean, not a map keyed by anything from a request, so it cannot grow.
let checked = false;

/**
 * Report the short secrets, once per instance. Does nothing unless `VERCEL`
 * is set (the same gate as the other warn-once logs in auth-helpers and
 * guest-auth), so local runs and tests with short fixture secrets stay quiet.
 *
 * The flag is set before the work, so a throw from the logger or Sentry costs
 * at most the first request, never every request.
 */
export function warnWeakSecretsOnce(): void {
  if (checked || !process.env.VERCEL) return;
  checked = true;

  const names = weakSecretNames();
  if (names.length === 0) return;

  logger.warn({ names }, WARNING_MESSAGE);
  Sentry.captureMessage(WARNING_MESSAGE, {
    level: 'warning',
    fingerprint: ['weak-secret'],
    extra: { names },
  });
}
