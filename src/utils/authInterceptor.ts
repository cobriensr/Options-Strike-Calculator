/**
 * Self-healing 401 fetch interceptor.
 *
 * The auth UI keys off JS-visible hint cookies (`sc-hint`, `sc-guest-hint`)
 * so the frontend can render the right shell on page load without a
 * whoami round-trip. The HttpOnly partners (`sc-owner`, `sc-guest`) are
 * the server's source of truth.
 *
 * When the partners drift — manual DevTools cookie clear, `OWNER_SECRET`
 * rotation, guest cookie eviction — the hint outlives its partner and
 * the user gets stuck: server 401s every request, but the UI still
 * shows owner/guest mode and never offers the Sign-in CTA.
 *
 * This wrapper closes the loop: any 401 from a non-`/api/auth/*` path
 * while a hint cookie is present clears the hint and fires
 * `AUTH_CLEARED_EVENT`, which `useAccessSession` listens for to re-
 * evaluate access mode and surface the Sign-in button.
 */

import { clearHintCookies, hasHintCookie } from './auth.js';

export const AUTH_CLEARED_EVENT = 'sc-auth-cleared';

let installed = false;

function extractUrl(input: RequestInfo | URL): string | null {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== 'undefined' && input instanceof Request)
    return input.url;
  return null;
}

/**
 * Auth endpoints can legitimately return 401 (wrong guest key, expired
 * OAuth state) without meaning the session is stale — those should not
 * trigger a hint-cookie wipe.
 */
function isAuthEndpoint(url: string): boolean {
  try {
    const path = url.startsWith('http')
      ? new URL(url).pathname
      : url.split('?')[0];
    return path?.startsWith('/api/auth/') ?? false;
  } catch {
    return false;
  }
}

/**
 * Pure wrapping function — testable without touching window. Returns a
 * fetch that delegates to `original`, then on 401 from a non-auth path
 * clears stale hint cookies and dispatches `AUTH_CLEARED_EVENT`.
 */
export function wrapFetch(original: typeof fetch): typeof fetch {
  return async function patchedFetch(input, init) {
    const res = await original(input, init);
    if (shouldClearHints(res, input)) {
      clearHintCookies();
      window.dispatchEvent(new CustomEvent(AUTH_CLEARED_EVENT));
    }
    return res;
  };
}

function shouldClearHints(res: Response, input: RequestInfo | URL): boolean {
  if (res.status !== 401) return false;
  if (!hasHintCookie()) return false;
  const url = extractUrl(input);
  if (!url) return false;
  return !isAuthEndpoint(url);
}

/**
 * Idempotent install on `window.fetch`. Safe to call multiple times
 * (a second call is a no-op).
 */
export function installAuthInterceptor(): void {
  if (installed) return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = wrapFetch(original);
}
