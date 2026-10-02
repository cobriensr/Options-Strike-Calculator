/**
 * Schwab refresh-token expiry: the thresholds and the classifier shared by
 * the owner status endpoint, the re-auth reminder cron, and the header
 * countdown badge, so all three agree on when a login is "expiring".
 *
 * Imported by `api/` (Node's strict ESM resolver) — keep this module free of
 * relative imports, or give them explicit `.js` extensions.
 *
 * Spec: docs/superpowers/specs/schwab-reauth-2026-09-29.md (A3).
 */

const HOUR_MS = 60 * 60 * 1000;

/** At or below this much remaining lifetime the login is "expiring" (amber). */
const SCHWAB_REAUTH_WARN_MS = 24 * HOUR_MS;

/** At or below this much remaining lifetime the login is urgent (red). */
const SCHWAB_REAUTH_URGENT_MS = 2 * HOUR_MS;

/**
 * Where a refresh token stands at `now`:
 *   - ok      — more than 24 h left
 *   - warn    — 24 h or less (and more than 2 h)
 *   - urgent  — 2 h or less, not yet past
 *   - expired — `now` is past `refreshExpiresAt`
 *
 * "Expired" uses the same strict `now > refreshExpiresAt` comparison as the
 * token guard in `api/_lib/schwab.ts`, so the badge never calls a login
 * expired that the server still treats as live.
 */
export type SchwabExpiryTier = 'ok' | 'warn' | 'urgent' | 'expired';

export function classifySchwabExpiry(
  refreshExpiresAt: number,
  now: number,
): SchwabExpiryTier {
  const remaining = refreshExpiresAt - now;
  if (remaining < 0) return 'expired';
  if (remaining <= SCHWAB_REAUTH_URGENT_MS) return 'urgent';
  if (remaining <= SCHWAB_REAUTH_WARN_MS) return 'warn';
  return 'ok';
}

const CT_EXPIRY_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

/**
 * The expiry as the owner reads it, in Central time: "Sun 7:30 PM CT". Used
 * in reminder pushes (which may be delivered hours late, so the time is
 * absolute rather than "in 2 h") and in the badge tooltip. Newer ICU builds
 * put a narrow no-break space before AM/PM; it is normalized to a plain
 * space so the text is the same on every runtime.
 */
export function formatSchwabExpiryCt(ms: number): string {
  const text = CT_EXPIRY_FORMAT.format(new Date(ms)).replace(
    /[\u202f\u00a0]/g,
    ' ',
  );
  return `${text} CT`;
}

/**
 * The non-secret view of the Schwab login served to the owner by
 * `GET /api/auth/schwab-status`. Never carries token values.
 *   - active / expiring / expired — a token record is stored; `expiring`
 *     covers both the warn and urgent tiers
 *   - logged_out — no token record (never logged in, or cleared after the
 *     login lapsed or Schwab rejected the refresh token)
 *   - unknown — the token store could not be read, or the stored record has
 *     no usable expiry. Never reported as logged_out.
 */
export type SchwabAuthStatus =
  | { state: 'active' | 'expiring' | 'expired'; refreshExpiresAt: number }
  | { state: 'logged_out' }
  | { state: 'unknown' };
