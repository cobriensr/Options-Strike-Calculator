/**
 * The Web Locks half of the cross-tab agreement behind the automatic update.
 * Applying a waiting service worker reloads every tab of the app, so a tab may
 * apply only when no other tab is unsafe (visible during the cash session, or
 * holding the update). One lock, `sw-update-unsafe`, carries that:
 *
 * - A tab that is unsafe holds it in shared mode (`holdUnsafeLock`) and lets go
 *   when it turns safe (`releaseUnsafeLock`). Shared holders don't block each
 *   other, and a closed tab's locks are released by the browser.
 * - A tab that wants to apply asks for it in exclusive mode with `ifAvailable`
 *   (`runIfNoTabUnsafe`). The browser grants that only when nothing holds the
 *   lock, i.e. no tab is unsafe, and otherwise calls back with `null` at once.
 *
 * Semantics checked against the W3C spec and MDN `LockManager.request()`: a lock
 * is held until the promise its callback returns settles; `ifAvailable` calls
 * the callback with `null` when the request isn't grantable; an exclusive
 * request is grantable only when nothing holds the name, shared holders
 * included, this tab's own among them; and `request()` settles after the lock
 * is released. That last point sets the order for a tab that turns safe: it must
 * wait for its own release before it asks for the exclusive lock, or the
 * request is answered before the release is processed and finds its own shared
 * lock held (`releaseUnsafeLock` returns that promise).
 *
 * The decisions (when a tab is unsafe, when to try) live in sw-update.ts. A
 * failed request is reported once at warning level and never throws to the
 * caller; the next tick retries.
 */

import { claimReport } from './response-guard';
import { captureUnlessAuth } from './sentry-helpers';

const UNSAFE_LOCK_NAME = 'sw-update-unsafe';

interface SharedHold {
  /** Ends the hold. The browser releases the lock a moment later. */
  end: () => void;
  /** Settles once the lock is released, or the request failed. */
  over: Promise<void>;
}

// This tab's one shared lock, or null. At most one is requested at a time.
let sharedHold: SharedHold | null = null;
// Latch for the last reported failure, so a persistent one isn't reported on
// every tick. A request that works clears it.
const lastReported: { current: string | null } = { current: null };

/** Whether this browser has the Web Locks API (secure contexts only). */
export function tabLocksAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'locks' in navigator;
}

function reportFailure(operation: 'shared' | 'exclusive', err: unknown): void {
  if (!claimReport(lastReported, operation)) return;
  captureUnlessAuth(err, {
    level: 'warning',
    tags: { context: 'sw_update_tabs' },
  });
}

async function requestShared(
  ended: Promise<void>,
  hold: SharedHold,
): Promise<void> {
  try {
    await navigator.locks.request(UNSAFE_LOCK_NAME, { mode: 'shared' }, () => {
      lastReported.current = null;
      return ended;
    });
  } catch (err: unknown) {
    // Fails open: a tab whose shared request is rejected holds no lock, so the
    // other tabs count it as safe even while it is not. Forget the hold so the
    // next evaluation asks again.
    if (sharedHold === hold) sharedHold = null;
    reportFailure('shared', err);
  }
}

/**
 * Take the shared lock, to tell the other tabs this one is unsafe. Does nothing
 * when it already has one, so evaluations can call it freely.
 */
export function holdUnsafeLock(): void {
  if (sharedHold) return;
  let end: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  const hold: SharedHold = { end, over: Promise.resolve() };
  // Set before the request: a request that throws at once runs the failure
  // path synchronously, which has to find this hold to clear it.
  sharedHold = hold;
  hold.over = requestShared(ended, hold);
}

/**
 * Let go of the shared lock. Resolves once the browser has released it, or at
 * once when this tab holds none; it never rejects. Ending a hold whose request
 * wasn't granted yet is fine: the lock is released as soon as it is granted.
 */
export function releaseUnsafeLock(): Promise<void> {
  const hold = sharedHold;
  if (!hold) return Promise.resolve();
  sharedHold = null;
  hold.end();
  return hold.over;
}

/**
 * Run `fn` only if no tab holds the lock (this tab included, so release first).
 * `fn` runs inside the exclusive lock, which is released as soon as it returns.
 * Resolves after the browser's answer; never rejects, and an error `fn` throws
 * is reported.
 */
export async function runIfNoTabUnsafe(fn: () => void): Promise<void> {
  try {
    await navigator.locks.request(
      UNSAFE_LOCK_NAME,
      { mode: 'exclusive', ifAvailable: true },
      (lock) => {
        if (lock) fn();
      },
    );
    lastReported.current = null;
  } catch (err: unknown) {
    // Fails closed: with no answer from the lock manager nothing applies, and
    // the next tick asks again. The banner's Reload still works.
    reportFailure('exclusive', err);
  }
}

/** Drop this tab's lock and the failure latch (used by `resetUpdateState`). */
export function resetUnsafeLock(): void {
  void releaseUnsafeLock();
  lastReported.current = null;
}
