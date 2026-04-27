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
 * Trigger the update. Posts SKIP_WAITING to the waiting SW; the SW takes
 * control, fires `controllerchange` on the page, and the existing
 * listener in main.tsx reloads. Calling this when no update is pending
 * is a no-op.
 */
export function applyUpdate(): void {
  if (!updateSWFn) return;
  // updateSW failures are surfaced by vite-plugin-pwa internally; on the
  // off chance the postMessage round-trip fails, the user can still reload
  // manually — silently swallowing here is intentional.
  updateSWFn(true).catch(() => {});
}

export function subscribeToUpdateState(cb: () => void): () => void {
  subscribers.add(cb);
  return (): void => {
    subscribers.delete(cb);
  };
}
