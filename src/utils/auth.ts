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
  if (document.cookie.includes('sc-hint=')) return 'owner';
  if (document.cookie.includes('sc-guest-hint=')) return 'guest';
  return 'public';
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
