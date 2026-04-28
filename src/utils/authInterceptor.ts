/**
 * Self-healing 401 fetch interceptor with debounce + server confirm.
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
 * ## Why this is debounced + server-confirmed
 *
 * The naive design ("any 401 → wipe hints") was too aggressive: a single
 * stray 401 from a transient blip, an owner-only endpoint accidentally
 * hit by guest UI, or a race during cookie rotation would force every
 * affected user to re-enter their key despite a perfectly valid HttpOnly
 * cookie. Two layers of defense keep false positives to zero:
 *
 *   1. **Debounce** — track 401 timestamps and only proceed after the
 *      DEBOUNCE_THRESHOLD'th 401 within DEBOUNCE_WINDOW_MS. One-off blips
 *      never trigger.
 *   2. **Server confirm** — call `/api/auth/whoami` (always 200) and act
 *      only when the server reports `mode === 'public'`. The server is
 *      the source of truth; the client's hint cookies are a render hint,
 *      not a session.
 *
 * A single in-flight probe is enforced so a burst of concurrent 401s
 * doesn't fan out into N whoami calls.
 */

import { clearHintCookies, hasHintCookie } from './auth.js';

export const AUTH_CLEARED_EVENT = 'sc-auth-cleared';

const DEBOUNCE_THRESHOLD = 2;
const DEBOUNCE_WINDOW_MS = 5000;

interface WhoamiResponse {
  mode: 'owner' | 'guest' | 'public';
}

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
 * count toward the debounce or trigger a probe.
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

function shouldConsider401(res: Response, input: RequestInfo | URL): boolean {
  if (res.status !== 401) return false;
  if (!hasHintCookie()) return false;
  const url = extractUrl(input);
  if (!url) return false;
  return !isAuthEndpoint(url);
}

/**
 * Pure wrapping function — testable without touching window. Returns a
 * fetch that delegates to `original`, then on 401 from a non-auth path
 * with a hint cookie present, records a debounce tick. Once the
 * threshold is reached within the window, fires a single in-flight
 * probe to `/api/auth/whoami`; if the server reports `public`, clears
 * the stale hint cookies and dispatches `AUTH_CLEARED_EVENT`.
 *
 * State is closure-scoped so each call to `wrapFetch` has its own
 * debounce counter — keeps tests independent without a reset hook.
 */
export function wrapFetch(original: typeof fetch): typeof fetch {
  const unauthorizedTimestamps: number[] = [];
  let probeInFlight: Promise<void> | null = null;

  function recordAndCheckThreshold(now: number): boolean {
    unauthorizedTimestamps.push(now);
    while (
      unauthorizedTimestamps.length > 0 &&
      now - (unauthorizedTimestamps[0] ?? 0) > DEBOUNCE_WINDOW_MS
    ) {
      unauthorizedTimestamps.shift();
    }
    return unauthorizedTimestamps.length >= DEBOUNCE_THRESHOLD;
  }

  async function probeAndMaybeClear(): Promise<void> {
    if (probeInFlight) return probeInFlight;
    probeInFlight = (async () => {
      try {
        const res = await original('/api/auth/whoami', {
          credentials: 'same-origin',
        });
        if (!res.ok) return;
        const data = (await res.json()) as WhoamiResponse;
        if (data.mode === 'public') {
          clearHintCookies();
          window.dispatchEvent(new CustomEvent(AUTH_CLEARED_EVENT));
          unauthorizedTimestamps.length = 0;
        }
      } catch {
        // Network error during probe — don't wipe; better a stuck UI
        // (recoverable by refresh) than a forced re-login on a blip.
      } finally {
        probeInFlight = null;
      }
    })();
    return probeInFlight;
  }

  return async function patchedFetch(input, init) {
    const res = await original(input, init);
    if (shouldConsider401(res, input)) {
      if (recordAndCheckThreshold(Date.now())) {
        void probeAndMaybeClear();
      }
    }
    return res;
  };
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
