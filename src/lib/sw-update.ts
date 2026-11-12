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
 *
 * Applying reloads every tab of the app, so where the browser has the Web
 * Locks API, `startTabAgreement` makes the tabs agree first: an unsafe tab
 * holds a shared lock, and a tab applies only when it can take that lock
 * exclusively, i.e. no tab holds it (sw-update-tabs.ts). Without the API each
 * tab decides alone, as before.
 */

import { claimReport } from './response-guard';
import { captureUnlessAuth } from './sentry-helpers';
import { isSafeToApplyUpdate } from './sw-update-policy';
import {
  holdUnsafeLock,
  releaseUnsafeLock,
  resetUnsafeLock,
  runIfNoTabUnsafe,
  tabLocksAvailable,
} from './sw-update-tabs';

type UpdateSW = (reloadPage?: boolean) => Promise<void>;

/** How often an open window asks the server for a new service worker. */
const UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000;
/**
 * How often a tab re-evaluates its own policy: while an update waits, so it
 * applies within a minute of a safe moment; and while the tab tracks its
 * safety for the other tabs, so the session's edges (the open, the close) are
 * noticed under a tab that stays visible.
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
/**
 * How long an automatic apply waits for the new worker to take control
 * (`controllerchange`) before the wait for a safe moment starts again.
 */
const APPLY_STALL_MS = 30 * 1000;

let updateSWFn: UpdateSW | null = null;
let needsRefresh = false;
const subscribers = new Set<() => void>();
// The one interval + visibilitychange listener `startUpdateChecks` owns.
let stopUpdateChecks: (() => void) | null = null;
// The one interval + visibilitychange listener that re-evaluates this tab's
// policy. It exists while an update waits or the tab agreement runs, whichever
// needs it, and never doubles up.
let stopWatch: (() => void) | null = null;
// An update waits for a safe moment: set by `markNeedsRefresh`, ended by
// `applyUpdate` and `resetUpdateState`.
let awaitingSafeMoment = false;
// Set while `startTabAgreement` runs: this tab announces its own safety to the
// other tabs and applies only when they agree.
let stopTabAgreement: (() => void) | null = null;
// An apply attempt that asks the other tabs is in flight. One at a time.
let askingTabs = false;
// Bumped by `resetUpdateState`, so an attempt that began before a reset can
// tell, and ends without touching what began after it.
let epoch = 0;
// The one timeout of an automatic apply that waits for `controllerchange`, and
// whether this page has reported a stall already (at most once per page).
let applyStallTimer: ReturnType<typeof setTimeout> | null = null;
let applyStallReported = false;
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
  awaitingSafeMoment = true;
  startWatch();
}

/** Reset (used in tests). Not called from app code. */
export function resetUpdateState(): void {
  stopUpdateChecks?.();
  awaitingSafeMoment = false;
  stopTabAgreement = null;
  stopWatch?.();
  resetUnsafeLock();
  clearApplyStall();
  detachControllerChange();
  applyStallReported = false;
  askingTabs = false;
  epoch += 1;
  holds.clear();
  needsRefresh = false;
  updateSWFn = null;
  subscribers.clear();
}

/**
 * Keep a waiting update from applying by itself until the returned release
 * runs, e.g. while a chart analysis is in flight. Holds stack, and calling a
 * release again does nothing. A release doesn't apply the update: it applies
 * at the next evaluation, any tab's next tick (up to 60 s later) or, without
 * Web Locks, this tab's own visibility change. A user who left the tab during
 * a long analysis and comes back within that time during the session finds the
 * result instead of a reload; outside the session the update applies once that
 * evaluation runs. A hold and the last release also update the shared lock at
 * once, so the other tabs know this one is busy.
 */
export function holdAutoUpdate(): () => void {
  const hold = Symbol('auto-update-hold');
  holds.add(hold);
  syncUnsafeLock();
  return (): void => {
    holds.delete(hold);
    syncUnsafeLock();
  };
}

/**
 * Whether this tab may be reloaded: the policy on its live state, now and one
 * tick from now. The second reading makes a visible tab unsafe from a tick
 * before the open, so it already holds its shared lock when the session starts
 * and another tab's attempt in the open's first minute can't reload it. At the
 * close it costs nothing: a tab is safe once both readings are.
 */
function isOwnPolicySafe(): boolean {
  const hidden = document.visibilityState === 'hidden';
  const busy = holds.size > 0;
  const now = Date.now();
  return [now, now + SAFE_MOMENT_INTERVAL_MS].every((at) =>
    isSafeToApplyUpdate({ hidden, now: new Date(at), busy }),
  );
}

/**
 * Make the shared lock match this tab's policy: held while the tab is unsafe,
 * released while it is safe. Resolves once a release has taken effect.
 */
function matchLockToPolicy(safe: boolean): Promise<void> {
  if (!safe) {
    holdUnsafeLock();
    return Promise.resolve();
  }
  return releaseUnsafeLock();
}

/**
 * Match the lock to the policy after a hold or a release, when nothing else
 * follows. Does nothing unless the tab agreement runs.
 */
function syncUnsafeLock(): void {
  if (stopTabAgreement) void matchLockToPolicy(isOwnPolicySafe());
}

/**
 * One evaluation, run every `SAFE_MOMENT_INTERVAL_MS` while the watch lives
 * (and, without the tab agreement, on every visibility change too).
 *
 * Tracking: keep the shared lock in step with the policy, and when the tab is
 * safe and an update waits, try to apply it once the other tabs agree.
 * Otherwise (no Web Locks, or the tracker never started) the tab decides
 * alone, which is the per-tab behavior from before the tabs agreed.
 */
function evaluate(): void {
  const safe = isOwnPolicySafe();
  if (!stopTabAgreement) {
    if (safe && awaitingSafeMoment) startApply(true);
    return;
  }
  const released = matchLockToPolicy(safe);
  if (safe && awaitingSafeMoment) applyWhenTabsAgree(released);
}

/**
 * The watch's `visibilitychange` listener. Switching tabs hides this tab and
 * shows another within a few milliseconds, and the other tab's shared lock is
 * granted a moment after that. An apply attempt set off by this change could
 * ask before that lock exists and reload the tab the owner just switched to.
 * So with the tab agreement running a visibility change only brings the lock
 * in step with the policy, and the tick, which isn't correlated with another
 * tab's transition, asks. Without the agreement the tab decides alone, on the
 * change, as before.
 */
function onWatchVisibilityChange(): void {
  if (stopTabAgreement) syncUnsafeLock();
  else evaluate();
}

/**
 * Apply if no other tab is unsafe. Waits for this tab's own shared lock to be
 * gone first, since an exclusive request is refused while any lock is held,
 * this tab's included. When another tab is unsafe the request is answered with
 * null and nothing happens; the next tick asks again. The tab is checked again
 * inside the lock, as it may have turned unsafe while the request was in
 * flight. One attempt at a time.
 */
function applyWhenTabsAgree(released: Promise<void>): void {
  if (askingTabs) return;
  askingTabs = true;
  void askTabsToApply(released);
}

async function askTabsToApply(released: Promise<void>): Promise<void> {
  const startedIn = epoch;
  try {
    await released;
    // A reset ends the attempt, and so does a Reload click, which ends the
    // wait: a wait that began after a reset is not this attempt's to apply.
    if (epoch === startedIn && awaitingSafeMoment) {
      await runIfNoTabUnsafe(applyIfStillSafe);
    }
  } finally {
    // After a reset the flag belongs to a newer attempt.
    if (epoch === startedIn) askingTabs = false;
  }
}

function applyIfStillSafe(): void {
  if (awaitingSafeMoment && isOwnPolicySafe()) startApply(true);
}

/**
 * Start the one interval and visibilitychange listener that run `evaluate`,
 * unless they run already. It lives while an update waits or the tab agreement
 * runs (`stopWatchIfIdle`).
 */
function startWatch(): void {
  if (stopWatch) return;
  const timer = setInterval(evaluate, SAFE_MOMENT_INTERVAL_MS);
  document.addEventListener('visibilitychange', onWatchVisibilityChange);
  const stop = (): void => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onWatchVisibilityChange);
    if (stopWatch === stop) stopWatch = null;
  };
  stopWatch = stop;
}

function stopWatchIfIdle(): void {
  if (!awaitingSafeMoment && !stopTabAgreement) stopWatch?.();
}

/**
 * Make the tabs of the app agree before any of them applies an update. Every
 * tab calls this at startup, whether or not an update waits: while the tab is
 * unsafe (`!isSafeToApplyUpdate`, i.e. visible during the cash session, or
 * holding the update) it holds the shared lock `sw-update-unsafe`, and it lets
 * go when it turns safe. The policy is re-checked on a visibility change, on a
 * hold and its release, and every `SAFE_MOMENT_INTERVAL_MS`. A tab counts as
 * unsafe from one tick before the open (`isOwnPolicySafe` looks one tick
 * ahead), so it already holds its lock when the session starts, not a tick
 * later, when another tab's attempt could have reloaded it. Only the tick asks
 * the other tabs; a visibility change just updates the lock. See
 * sw-update-tabs.ts.
 *
 * Does nothing in a browser without the Web Locks API (every browser the owner
 * uses has it): each tab then decides alone, the per-tab rule. It shares the
 * watch's one timer and listener with a waiting update. A second call returns
 * the first call's stop; a stale stop does nothing; `resetUpdateState()` also
 * stops it.
 */
export function startTabAgreement(): () => void {
  if (stopTabAgreement) return stopTabAgreement;
  if (!tabLocksAvailable()) return () => undefined;
  const stop = (): void => {
    if (stopTabAgreement !== stop) return;
    stopTabAgreement = null;
    void releaseUnsafeLock();
    stopWatchIfIdle();
  };
  stopTabAgreement = stop;
  startWatch();
  syncUnsafeLock();
  return stop;
}

export function getNeedsRefresh(): boolean {
  return needsRefresh;
}

/**
 * Trigger the update. Attaches a one-shot `controllerchange` listener so the
 * page reloads exactly when the new SW takes control, then posts SKIP_WAITING
 * to the waiting SW. The listener is attached only by an apply (not at
 * startup) so that unrelated controllerchange events — first-install
 * activation in particular — don't trigger spurious reloads mid-load. Calling
 * when no update is pending is a no-op.
 *
 * Also ends the wait for a safe moment, so a Reload click stops the automatic
 * apply. The reverse isn't guarded: a click after an automatic apply repeats
 * `updateSW(true)`, a second SKIP_WAITING, which is harmless (the one
 * `controllerchange` listener is shared, see `onControllerChange`). There is
 * deliberately no "applied" flag, because the manual retry after a failed
 * `updateSW` (see below) has to keep working. A click doesn't ask the other
 * tabs: the owner chose to reload now, and the agreement binds only the
 * automatic apply. It arms no stall timeout either (see `startApply`): the
 * banner stays, so the user can click again, and a click takes over from the
 * timeout of an earlier automatic apply.
 */
export function applyUpdate(): void {
  startApply(false);
}

/**
 * The apply itself, by the user's click (`automatic` false) or by this module
 * at a safe moment. `updateSW(true)` only posts SKIP_WAITING to the waiting
 * worker: in the installed vite-plugin-pwa/workbox-window it never rejects, and
 * it does nothing when no worker waits, so a failed or lost apply makes no
 * sound. It shows up as a `controllerchange` that never comes, which the
 * automatic path watches for: after `APPLY_STALL_MS` without one it reports a
 * warning (once per page) and goes back to waiting for a safe moment, so the
 * next one retries. The same `controllerchange` that reloads the page clears
 * the timeout. Nothing to wait for without a service worker container.
 */
function startApply(automatic: boolean): void {
  if (!updateSWFn) return;
  awaitingSafeMoment = false;
  stopWatchIfIdle();
  clearApplyStall();
  const hasContainer = 'serviceWorker' in navigator;
  if (hasContainer) {
    navigator.serviceWorker.addEventListener(
      'controllerchange',
      onControllerChange,
      { once: true },
    );
  }
  // Defensive: nothing in the installed plugin rejects here (see above). If
  // one ever does, capture at warning level, as the manual-reload path keeps
  // the UX usable.
  updateSWFn(true).catch((err: unknown) => {
    captureUnlessAuth(err, {
      level: 'warning',
      tags: { context: 'sw_update_apply' },
    });
  });
  if (automatic && hasContainer) {
    applyStallTimer = setTimeout(onApplyStalled, APPLY_STALL_MS);
  }
}

/**
 * The page reloads when the new worker takes control. One function for every
 * apply, so a repeat `addEventListener` with it is ignored and at most one
 * listener lives however many applies stall or get clicked.
 */
function onControllerChange(): void {
  clearApplyStall();
  window.location.reload();
}

function detachControllerChange(): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.removeEventListener(
    'controllerchange',
    onControllerChange,
  );
}

function clearApplyStall(): void {
  if (applyStallTimer === null) return;
  clearTimeout(applyStallTimer);
  applyStallTimer = null;
}

function onApplyStalled(): void {
  applyStallTimer = null;
  if (!applyStallReported) {
    applyStallReported = true;
    captureUnlessAuth(
      new Error('The new service worker did not take control after an apply'),
      { level: 'warning', tags: { context: 'sw_update_apply_stalled' } },
    );
  }
  awaitingSafeMoment = true;
  startWatch();
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
    // workbox-window stops listening for `updatefound` after the first
    // external update, so a later deploy can leave a worker waiting with no
    // `onNeedRefresh`, and the tab on the old bundle for good. A waiting
    // worker is local state: look before any gate. (`markNeedsRefresh` does
    // nothing when an update is already marked.)
    if (registration.waiting) markNeedsRefresh();
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
