/**
 * UpdateAvailableBanner — toast-style "new version available" prompt.
 *
 * Renders nothing until vite-plugin-pwa's onNeedRefresh fires (a new SW
 * has installed and is in the waiting state). Then surfaces a small
 * fixed-position banner with a Reload button. Clicking Reload calls
 * `updateSW(true)`, which posts SKIP_WAITING to the new SW; the new SW
 * takes control, controllerchange fires, and the existing listener in
 * main.tsx reloads the page.
 *
 * Visible to everyone (owner + guest + public) — universal chrome.
 */

import { useUpdateAvailable } from '../../hooks/useUpdateAvailable';

export default function UpdateAvailableBanner() {
  const { available, applyUpdate } = useUpdateAvailable();
  if (!available) return null;

  return (
    <div
      role="status"
      aria-label="New version available"
      aria-live="polite"
      className="bg-surface border-edge-strong fixed right-4 bottom-4 z-[300] flex max-w-sm items-center gap-3 rounded-xl border p-3 shadow-2xl"
    >
      <span aria-hidden="true" className="text-accent text-lg">
        ✦
      </span>
      <div className="flex-1">
        <p className="text-primary font-sans text-sm font-semibold">
          New version available
        </p>
        <p className="text-secondary text-xs">
          Reload to pick up the latest update.
        </p>
      </div>
      <button
        type="button"
        onClick={applyUpdate}
        className="bg-accent rounded-lg px-3 py-1.5 font-sans text-xs font-semibold text-white transition-opacity hover:opacity-90"
      >
        Reload
      </button>
    </div>
  );
}
