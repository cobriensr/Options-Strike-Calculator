/**
 * Open and close signals for the live-snapshot stall alert. A live-save
 * browser tells the server when the app closes and, while it stays open,
 * that it is still open, so the cron (`api/cron/check-live-snapshots.ts`)
 * can tell "the owner closed the app" from "the app stopped saving".
 * Spec: docs/superpowers/specs/live-snapshot-alert-2026-11-11.md, second,
 * fourth and fifth amendments.
 *
 *   - Close: on `pagehide`, a POST to /api/snapshot-close writes today's close
 *     marker. `sendBeacon` first (it survives the page going away), else a
 *     keepalive `fetch`, whose failure is swallowed: nothing can be reported
 *     from a page that is leaving. Not gated on the session; a close outside
 *     it is harmless. `pagehide`, not `beforeunload` or `unload`: it fires
 *     reliably and keeps the page eligible for the back/forward cache. Not
 *     `visibilitychange`: hiding a tab is not closing it. It also fires on a
 *     reload, which the reloaded page's open signals withdraw.
 *   - Open: a DELETE to the same path removes today's close marker. Sent when
 *     the module starts, 30 s later (a reload's close beacon can reach the
 *     server after the new page's first open signal), every 5 minutes, when
 *     this tab's switch flips on, and when the page returns from the
 *     back/forward cache. Each one only inside the cash session, like every
 *     other poll here. A 401 (the owner cookie is gone) and a 429 (the shared
 *     30 a minute limit; the next timer retries) are silent, and so is any
 *     failure while the browser is offline; any other failure is reported once
 *     per page, because a lost open signal can let a close stand. Keep it a plain same-origin `fetch` with no body, no custom
 *     headers and no `mode`: the endpoint's cross-site safety rests on DELETE
 *     needing a preflight it never answers (security review, 2026-11-12).
 *
 * Runs only for the owner on a live-save device. Neither is cached: the
 * owner check reads the hint cookie, and the device check reads the stored
 * switch, at the moment each timer fires and inside the `pagehide` and
 * `pageshow` handlers. `subscribeLiveSaveDevice` tells only this tab, so a
 * switch flipped in another tab of the browser, or a sign-out elsewhere, is
 * never pushed here; the subscription only lets this tab react at once.
 *
 * Started from main.tsx, outside React and after botid has wrapped `fetch`, so
 * a render failure in a new build does not stop the open signal. A new build
 * whose entry module fails to evaluate (any eagerly imported module throwing
 * at import time) does stop it: it sends no open signal, so a reload into it
 * can still hide a stall. The timers run for the life of the page and send
 * nothing while the page is not active; stopping removes every listener and
 * timer.
 */

import { getAccessMode } from '../utils/auth';
import { isLiveSaveDevice, subscribeLiveSaveDevice } from './live-save-device';
import { captureUnlessAuth } from './sentry-helpers';
import { isCashSessionOpen } from './sw-update-policy';

const SIGNAL_URL = '/api/snapshot-close';

/** The second open signal after load. */
const FOLLOW_UP_MS = 30 * 1000;

/**
 * The open signal's cadence. A closed sibling tab's close is withdrawn within
 * this long, well inside the cron's 30-minute stale threshold.
 */
const INTERVAL_MS = 5 * 60 * 1000;

/** The run in progress, so a second start replaces it instead of stacking. */
let stopCurrent: (() => void) | null = null;

/** Whether this page may send a signal right now. Reads fresh every time. */
function isActive(): boolean {
  return getAccessMode() === 'owner' && isLiveSaveDevice();
}

/**
 * "The page was closed". The beacon is queued by the browser even as the page
 * goes away. If it refuses the request (false), throws, or is missing (calling
 * it is then a TypeError, caught here too), a keepalive `fetch` carries the
 * same POST. The beacon is the real path: `sendBeacon` is not wrapped by
 * botid. The fallback is, because POST /api/snapshot-close is in botid's
 * `protect` list, and the wrapper awaits a challenge token first, so on a page
 * that is unloading the request may never leave.
 */
function sendClose(): void {
  try {
    if (navigator.sendBeacon(SIGNAL_URL)) return;
  } catch {
    // Fall through to the keepalive request.
  }
  fetch(SIGNAL_URL, { method: 'POST', keepalive: true }).catch(() => undefined);
}

/**
 * Start the open and close signals and return the function that stops them.
 * A second call stops the first run and starts afresh, so timers and
 * listeners never stack (a development reload re-runs main.tsx); a stop
 * returned by an earlier call leaves the current run alone.
 */
export function startLiveSessionSignals(): () => void {
  stopCurrent?.();

  // The page's one report of a failed open signal. A failure while the browser
  // is offline (a laptop waking up) is routine, as for the update check: it is
  // not reported and does not spend the one report, so a later failure online
  // still is.
  let reported = false;
  const reportOnce = (err: unknown): void => {
    if (reported || navigator.onLine === false) return;
    reported = true;
    captureUnlessAuth(err, {
      level: 'warning',
      tags: { context: 'live_session_open_signal' },
    });
  };

  /**
   * "A tab of the app is open", when the page is active and the cash session
   * is. Never throws or rejects, so the switch's subscriber loop (which
   * `setLiveSaveOverride` runs unguarded) and the timers can call it as is.
   */
  const sendOpenSignal = async (): Promise<void> => {
    try {
      if (!isActive() || !isCashSessionOpen(new Date())) return;
      const res = await fetch(SIGNAL_URL, { method: 'DELETE' });
      if (res.ok || res.status === 401 || res.status === 429) return;
      const err = new Error(
        `Open signal failed: HTTP ${res.status}`,
      ) as Error & { status?: number };
      err.status = res.status;
      reportOnce(err);
    } catch (err: unknown) {
      reportOnce(err);
    }
  };

  const onPageHide = (): void => {
    if (isActive()) sendClose();
  };
  const onPageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) void sendOpenSignal();
  };
  const onSwitchChange = (): void => {
    void sendOpenSignal();
  };

  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);
  const unsubscribe = subscribeLiveSaveDevice(onSwitchChange);
  const followUp = setTimeout(() => {
    void sendOpenSignal();
  }, FOLLOW_UP_MS);
  const interval = setInterval(() => {
    void sendOpenSignal();
  }, INTERVAL_MS);

  const stop = (): void => {
    clearTimeout(followUp);
    clearInterval(interval);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
    unsubscribe();
    if (stopCurrent === stop) stopCurrent = null;
  };
  stopCurrent = stop;

  void sendOpenSignal();
  return stop;
}
