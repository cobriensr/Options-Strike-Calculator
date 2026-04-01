/**
 * Check if the current session belongs to the site owner.
 * Returns true in local dev or when the sc-hint cookie is present
 * (set during Schwab OAuth callback).
 */
export function useIsOwner(): boolean {
  return import.meta.env.DEV || document.cookie.includes('sc-hint=');
}
