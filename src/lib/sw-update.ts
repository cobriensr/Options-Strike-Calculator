/**
 * Module-level bridge between the SW registration (in main.tsx) and the
 * React tree (UpdateAvailableBanner). vite-plugin-pwa's `registerSW`
 * runs outside React; this module captures the `updateSW` function and a
 * "needs refresh" flag, and lets components subscribe.
 *
 * Same subscriber-set pattern as useAccessSession — small, no React
 * Context, and the banner can sit anywhere in the tree without
 * prop-drilling.
 *
 * It also owns the periodic check for a new service worker
 * (`startUpdateChecks`): browsers look for one only on a page load, and this
 * single-page app can stay open for days.
 */

import { captureUnlessAuth } from './sentry-helpers';

type UpdateSW = (reloadPage?: boolean) => Promise<void>;

/** How often an open window asks the server for a new service worker. */
const UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000;
/**
 * A tab-focus check is skipped when any check started within this window, so
 * switching tabs can't fire a request each time.
 */
const VISIBLE_CHECK_THROTTLE_MS = 60 * 1000;

let updateSWFn: UpdateSW | null = null;
let needsRefresh = false;
const subscribers = new Set<() => void>();
// The one interval + visibilitychange listener `startUpdateChecks` owns.
let stopUpdateChecks: (() => void) | null = null;

function notifyAll(): void {
  for (const s of subscribers) s();
}

/** Called once at startup with the function returned by registerSW. */
export function setUpdateFn(fn: UpdateSW): void {
  updateSWFn = fn;
}

/** Called from the registerSW `onNeedRefresh` callback. */
export function markNeedsRefresh(): void {
  if (needsRefresh) return;
  needsRefresh = true;
  notifyAll();
}

/** Reset (used in tests). Not called from app code. */
export function resetUpdateState(): void {
  stopUpdateChecks?.();
  needsRefresh = false;
  updateSWFn = null;
  subscribers.clear();
}

export function getNeedsRefresh(): boolean {
  return needsRefresh;
}

/**
 * Trigger the update. Attaches a one-shot `controllerchange` listener so the
 * page reloads exactly when the new SW takes control, then posts SKIP_WAITING
 * to the waiting SW. Listener is scoped to this call (not global) so that
 * unrelated controllerchange events — first-install activation in particular
 * — don't trigger spurious reloads mid-load. Calling when no update is
 * pending is a no-op.
 */
export function applyUpdate(): void {
  if (!updateSWFn) return;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener(
      'controllerchange',
      () => {
        window.location.reload();
      },
      { once: true },
    );
  }
  // updateSW failures are surfaced by vite-plugin-pwa internally; on the
  // off chance the postMessage round-trip fails, the user can still reload
  // manually. Capture at warning level (not error) — the manual-reload
  // path keeps the UX usable, but persistent SW update failures across
  // users would indicate a real PWA regression worth investigating.
  updateSWFn(true).catch((err: unknown) => {
    captureUnlessAuth(err, {
      level: 'warning',
      tags: { context: 'sw_update_apply' },
    });
  });
}

/**
 * `fetch()` rejects with a TypeError on a network error, and
 * `ServiceWorkerRegistration.update()` with a TypeError when it can't fetch
 * the worker script (offline, DNS, a laptop just waking up). Anything that
 * lands while the browser reports offline is the same condition. Neither is
 * worth a Sentry event; the next tick retries. `update()` also uses a
 * TypeError for a script that fails to evaluate, which this can't tell apart.
 */
function isNetworkFailure(err: unknown): boolean {
  return err instanceof TypeError || navigator.onLine === false;
}

/**
 * Ask the server for a new service worker every `UPDATE_CHECK_INTERVAL_MS`
 * and when the tab becomes visible (at most once a minute), so an open window
 * notices a deploy and `onNeedRefresh` can fire. Called from the `registerSW`
 * `onRegisteredSW` callback, which can hand over an undefined registration;
 * that call does nothing.
 *
 * Follows vite-plugin-pwa's "Periodic Service Worker Updates > Handling Edge
 * Cases" guide: skip while a worker is installing or the browser is offline,
 * and only call `update()` after the script URL answers 200 uncached, so a
 * server that is down can't make `update()` throw.
 *
 * Owns one interval and one listener. A second call stops the first and
 * starts afresh, so timers never stack; the returned stop function only
 * stops its own call. `resetUpdateState()` also stops the checks.
 */
export function startUpdateChecks(
  registration: ServiceWorkerRegistration | undefined,
  swUrl: string,
): () => void {
  if (!registration) return () => undefined;
  stopUpdateChecks?.();

  let inFlight = false;
  let lastCheckStartedAt = Number.NEGATIVE_INFINITY;

  const check = async (): Promise<void> => {
    if (inFlight || registration.installing || navigator.onLine === false) {
      return;
    }
    inFlight = true;
    lastCheckStartedAt = Date.now();
    try {
      const response = await fetch(swUrl, { cache: 'no-store' });
      if (response.status === 200) await registration.update();
    } catch (err: unknown) {
      if (!isNetworkFailure(err)) {
        captureUnlessAuth(err, {
          level: 'warning',
          tags: { context: 'sw_update_check' },
        });
      }
    } finally {
      inFlight = false;
    }
  };

  const onVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastCheckStartedAt < VISIBLE_CHECK_THROTTLE_MS) return;
    void check();
  };

  const timer = setInterval(() => {
    void check();
  }, UPDATE_CHECK_INTERVAL_MS);
  document.addEventListener('visibilitychange', onVisibilityChange);

  const stop = (): void => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (stopUpdateChecks === stop) stopUpdateChecks = null;
  };
  stopUpdateChecks = stop;
  return stop;
}

export function subscribeToUpdateState(cb: () => void): () => void {
  subscribers.add(cb);
  return (): void => {
    subscribers.delete(cb);
  };
}
