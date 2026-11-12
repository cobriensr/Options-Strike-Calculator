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
 * single-page app can stay open for days. Once an update waits, it applies it
 * by itself at the first safe moment (`isSafeToApplyUpdate`), unless something
 * holds it (`holdAutoUpdate`); the banner's Reload still applies it at once.
 */

import { claimReport } from './response-guard';
import { captureUnlessAuth } from './sentry-helpers';
import { isSafeToApplyUpdate } from './sw-update-policy';

type UpdateSW = (reloadPage?: boolean) => Promise<void>;

/** How often an open window asks the server for a new service worker. */
const UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000;
/**
 * How often a waiting update asks whether this is a safe moment to apply it,
 * so it applies within a minute of one arriving.
 */
const SAFE_MOMENT_INTERVAL_MS = 60 * 1000;
/**
 * A tab-focus check is skipped when any check started within this window, so
 * switching tabs can't fire a request each time.
 */
const VISIBLE_CHECK_THROTTLE_MS = 60 * 1000;
/**
 * The sw.js fetch (about 29 KB) gives up after this, so a stalled connection
 * frees the in-flight guard before the next focus check.
 */
const FETCH_TIMEOUT_MS = 30 * 1000;

let updateSWFn: UpdateSW | null = null;
let needsRefresh = false;
const subscribers = new Set<() => void>();
// The one interval + visibilitychange listener `startUpdateChecks` owns.
let stopUpdateChecks: (() => void) | null = null;
// The one interval + visibilitychange listener that waits for a safe moment.
// It exists only while an update waits: `applyUpdate` and
// `resetUpdateState` end it.
let stopSafeMomentWatch: (() => void) | null = null;
// One token per open `holdAutoUpdate`, so a release is idempotent by
// construction and a release from before a reset finds nothing to remove.
const holds = new Set<symbol>();

function notifyAll(): void {
  for (const s of subscribers) s();
}

/** Called once at startup with the function returned by registerSW. */
export function setUpdateFn(fn: UpdateSW): void {
  updateSWFn = fn;
}

/**
 * Called from the registerSW `onNeedRefresh` callback. Starts the wait for a
 * safe moment. The first evaluation is one tick away, not inside this call:
 * the banner shows first, and its own Reload click right after (as in its
 * test, whatever the hour) is the only apply.
 */
export function markNeedsRefresh(): void {
  if (needsRefresh) return;
  needsRefresh = true;
  notifyAll();
  watchForSafeMoment();
}

/** Reset (used in tests). Not called from app code. */
export function resetUpdateState(): void {
  stopUpdateChecks?.();
  stopSafeMomentWatch?.();
  holds.clear();
  needsRefresh = false;
  updateSWFn = null;
  subscribers.clear();
}

/**
 * Keep a waiting update from applying by itself until the returned release
 * runs, e.g. while a chart analysis is in flight. Holds stack, and calling a
 * release again does nothing. A release doesn't apply the update: the next
 * evaluation does, within a minute or on a visibility change. A user who left
 * the tab during a long analysis and comes back in that minute finds the
 * result instead of a reload.
 */
export function holdAutoUpdate(): () => void {
  const hold = Symbol('auto-update-hold');
  holds.add(hold);
  return (): void => {
    holds.delete(hold);
  };
}

function applyIfSafe(): void {
  const safe = isSafeToApplyUpdate({
    hidden: document.visibilityState === 'hidden',
    now: new Date(),
    busy: holds.size > 0,
  });
  if (safe) applyUpdate();
}

/**
 * Evaluate the safe-moment policy every `SAFE_MOMENT_INTERVAL_MS` and on every
 * visibility change, until `applyUpdate` ends the watch.
 */
function watchForSafeMoment(): void {
  const timer = setInterval(applyIfSafe, SAFE_MOMENT_INTERVAL_MS);
  document.addEventListener('visibilitychange', applyIfSafe);
  stopSafeMomentWatch = (): void => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', applyIfSafe);
    stopSafeMomentWatch = null;
  };
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
 *
 * Also ends the wait for a safe moment, so the banner's Reload and the
 * automatic apply can't both run: the update applies once per page.
 */
export function applyUpdate(): void {
  if (!updateSWFn) return;
  stopSafeMomentWatch?.();
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

/** Where a check was when it failed: fetching sw.js, or in `update()`. */
type CheckStage = 'fetch' | 'update';

/**
 * Whether a failed check is routine, so it needs no Sentry event: the browser
 * reports offline, or the sw.js fetch hit a network error (`fetch()` rejects
 * with a TypeError) or timed out (a `TimeoutError` DOMException), as when a
 * laptop wakes up. The next tick retries. A rejection from `update()` is not
 * routine, even a TypeError: the 200 just showed the server answers, and
 * `update()` rejects with a TypeError when the new script fails to evaluate,
 * which would leave every open window on the old bundle.
 */
function isRoutineFailure(err: unknown, stage: CheckStage): boolean {
  if (navigator.onLine === false) return true;
  return stage === 'fetch' && (err instanceof TypeError || isTimeout(err));
}

function isTimeout(err: unknown): boolean {
  return errorName(err) === 'TimeoutError';
}

/** The latch key for a failure: its `name`, or its type when it has none. */
function errorName(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'name' in err) {
    if (typeof err.name === 'string') return err.name;
  }
  return typeof err;
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
 * server that is down can't make `update()` throw. That fetch times out after
 * `FETCH_TIMEOUT_MS`.
 *
 * A failure is reported to Sentry as a warning unless it is routine (see
 * `isRoutineFailure`), and a repeat of the last reported kind stays quiet until
 * a check succeeds, so a script that keeps failing doesn't send an event per
 * tick. The latch belongs to the run, so a restart drops it.
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
  const lastReported: { current: string | null } = { current: null };

  const check = async (): Promise<void> => {
    if (inFlight || registration.installing || navigator.onLine === false) {
      return;
    }
    inFlight = true;
    lastCheckStartedAt = Date.now();
    let stage: CheckStage = 'fetch';
    try {
      const response = await fetch(swUrl, {
        cache: 'no-store',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      // Only the status matters; release the unread body. A failed cancel
      // changes nothing.
      response.body?.cancel().catch(() => undefined);
      if (response.status === 200) {
        stage = 'update';
        await registration.update();
        lastReported.current = null;
      }
    } catch (err: unknown) {
      if (
        !isRoutineFailure(err, stage) &&
        claimReport(lastReported, errorName(err))
      ) {
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
