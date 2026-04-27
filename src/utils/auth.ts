/**
 * Owner-session predicates.
 *
 * Single-owner app — see CLAUDE.md "Auth is single-owner". The Schwab
 * OAuth callback sets the `sc-hint` cookie to mark the session as the
 * site owner; everyone else is a guest. Local dev is treated as owner
 * for ergonomic reasons.
 *
 * `checkIsOwner` is a plain function, not a React hook. The previous
 * `useIsOwner` hook had no React internals (no useState/useEffect) and
 * was named with the `use` prefix only by mistake. Plain function lets
 * callers invoke it conditionally, inside callbacks, or inside loops
 * without tripping the Rules of Hooks linter.
 */

/**
 * Returns true when the current browser session is the site owner —
 * i.e. running in local dev or carrying the `sc-hint` marker cookie.
 */
export function checkIsOwner(): boolean {
  return import.meta.env.DEV || document.cookie.includes('sc-hint=');
}
