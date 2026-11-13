/**
 * Renews the owner sign-in. The owner cookies last 400 days and
 * `GET /api/auth/whoami` re-issues them, with a fresh 400 days, for a browser
 * that already holds them. This module makes that call when the app starts and
 * then at most once every 24 hours while the window stays open, so a window
 * that is never closed does not reach the end of the 400 days.
 * Spec: docs/superpowers/specs/owner-session-long-lived-2026-11-11.md, Task 2.
 *
 * The mode is read fresh, at start and at every check, because the hint cookie
 * can appear (a sign-in in this window) or go (the 401 interceptor clears it)
 * while the page lives. Only the owner asks; a guest or a visitor sends
 * nothing, and the server would set no cookie for them anyway.
 *
 * "At most once a day" is judged on the wall clock, `Date.now()`, against the
 * time of the last attempt, success or not. An hourly check and a
 * `visibilitychange` back to a visible tab both ask whether a day has passed.
 * Neither counts ticks, so a hidden tab's throttled timers and a laptop that
 * slept through the day both renew as soon as the page next looks.
 *
 * A failure is silent and is not retried before the next day or the next start:
 * a failed request (a laptop waking, a network blip, a 5xx the server reports
 * itself) does not matter to a cookie with months left. It does not go through
 * the 401 interceptor either: `whoami` always answers 200, and a `/api/auth/*`
 * path is never counted by it.
 *
 * Started from main.tsx, outside React, so a render failure in a new build
 * does not stop the renewal. The timer runs for the life of the page; stopping
 * removes the timer and the listener.
 */

import { getAccessMode } from '../utils/auth';

const WHOAMI_URL = '/api/auth/whoami';

/** The least time between two asks. */
const RENEW_EVERY_MS = 24 * 60 * 60 * 1000;

/** How often a window left open and visible checks whether a day has passed. */
const CHECK_EVERY_MS = 60 * 60 * 1000;

/** The run in progress, so a second start replaces it instead of stacking. */
let stopCurrent: (() => void) | null = null;

/**
 * Start the renewal and return the function that stops it. A second call stops
 * the first run and starts afresh, so timers and listeners never stack (a
 * development reload re-runs main.tsx); a stop returned by an earlier call
 * leaves the current run alone.
 */
export function startOwnerSessionRenewal(): () => void {
  stopCurrent?.();

  // When this run last asked, whether or not the request worked.
  let lastAskedAt: number | null = null;

  /**
   * Ask whoami if this is the owner and a day has passed since the last ask.
   * Never throws or rejects, so the timer, the listener and main.tsx can call
   * it as is.
   */
  const renewIfDue = async (): Promise<void> => {
    try {
      if (getAccessMode() !== 'owner') return;
      const now = Date.now();
      if (lastAskedAt !== null && now - lastAskedAt < RENEW_EVERY_MS) return;
      lastAskedAt = now;
      await fetch(WHOAMI_URL);
    } catch {
      // Silent by design; see the header.
    }
  };

  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') void renewIfDue();
  };

  document.addEventListener('visibilitychange', onVisibilityChange);
  const interval = setInterval(() => {
    void renewIfDue();
  }, CHECK_EVERY_MS);

  const stop = (): void => {
    clearInterval(interval);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (stopCurrent === stop) stopCurrent = null;
  };
  stopCurrent = stop;

  void renewIfDue();
  return stop;
}
