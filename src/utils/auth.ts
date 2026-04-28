/**
 * Access-mode predicates.
 *
 * Single-owner app — see CLAUDE.md "Auth is single-owner". Three modes:
 *
 *   - 'owner'  — running in local dev, or carrying the `sc-hint` cookie
 *                set by the Schwab OAuth callback.
 *   - 'guest'  — carrying the `sc-guest-hint` cookie set by a successful
 *                POST to /api/auth/guest-key. Read-only access; the
 *                Chart Analysis submit button is disabled in this mode.
 *   - 'public' — neither cookie present. Calculator + free data only.
 *
 * These are plain functions, not React hooks. The previous `useIsOwner`
 * hook had no React internals — naming it with `use` only confused the
 * Rules of Hooks linter. Plain functions can be called inside callbacks,
 * conditionals, or loops without ceremony.
 */

export type AccessMode = 'owner' | 'guest' | 'public';

/**
 * Returns the current browser session's access mode.
 *
 * Owner wins over guest: a developer who happens to have both the dev
 * env AND a guest hint cookie still gets full owner access.
 */
export function getAccessMode(): AccessMode {
  if (import.meta.env.DEV) return 'owner';
  if (hasCookie('sc-hint')) return 'owner';
  if (hasCookie('sc-guest-hint')) return 'guest';
  return 'public';
}

/**
 * Anchored cookie probe. `document.cookie.includes('sc-hint=')` would
 * false-positive on a cookie like `not-sc-hint=1`; this matches only at
 * the start of the string or after the `; ` separator.
 */
function hasCookie(name: string): boolean {
  return new RegExp(`(^|; )${name}=`).test(document.cookie);
}

/**
 * Returns true when the current browser session is the site owner.
 * Kept as a thin wrapper over `getAccessMode` so callers that only
 * care about the binary owner/non-owner split don't have to compare
 * to a string literal.
 */
export function checkIsOwner(): boolean {
  return getAccessMode() === 'owner';
}

/**
 * JS-visible hint cookies paired with the HttpOnly server cookies:
 *   - `sc-hint`        ↔ `sc-owner`
 *   - `sc-guest-hint`  ↔ `sc-guest`
 *
 * The hints exist solely so the frontend can render the right UI on
 * page load without an extra round-trip. When the server-side partner
 * is missing/invalid (manual cookie clear, OWNER_SECRET rotation, guest
 * cookie eviction), the hint can drift — and a stale hint locks the user
 * into a UI mode where every request 401s.
 */
const HINT_COOKIES = ['sc-hint', 'sc-guest-hint'] as const;

/**
 * Cheap probe used by the fetch interceptor to skip the clear+notify
 * path when there's nothing to clear. Pure cookie check (does NOT use
 * `getAccessMode`, which short-circuits to 'owner' in dev builds).
 */
export function hasHintCookie(): boolean {
  return HINT_COOKIES.some((name) => hasCookie(name));
}

/**
 * Clears the JS-visible hint cookies. Called when the server reports
 * 401 on a request the frontend believed was authenticated — the
 * mismatch means the hint is stale and must be discarded. The real
 * HttpOnly partners (sc-owner / sc-guest) are server-managed and not
 * touched here.
 */
export function clearHintCookies(): void {
  const isHttps =
    typeof location !== 'undefined' && location.protocol === 'https:';
  const secure = isHttps ? '; Secure' : '';
  for (const name of HINT_COOKIES) {
    document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Strict${secure}`;
  }
}
