/**
 * Module-level bridge between the SW registration (in main.tsx) and the
 * React tree (UpdateAvailableBanner). vite-plugin-pwa's `registerSW`
 * runs outside React; this module captures the `updateSW` function and a
 * "needs refresh" flag, and lets components subscribe.
 *
 * Same subscriber-set pattern as useAccessSession — small, no React
 * Context, and the banner can sit anywhere in the tree without
 * prop-drilling.
 */

import { captureUnlessAuth } from './sentry-helpers';

type UpdateSW = (reloadPage?: boolean) => Promise<void>;

let updateSWFn: UpdateSW | null = null;
let needsRefresh = false;
const subscribers = new Set<() => void>();

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

export function subscribeToUpdateState(cb: () => void): () => void {
  subscribers.add(cb);
  return (): void => {
    subscribers.delete(cb);
  };
}
