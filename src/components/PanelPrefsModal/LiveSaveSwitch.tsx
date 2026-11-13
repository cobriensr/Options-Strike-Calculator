/**
 * LiveSaveSwitch — the owner's per-browser switch for saving live snapshots.
 *
 * Phones and tablets don't save live snapshots by default and computers do
 * (docs/superpowers/specs/live-snapshot-alert-2026-11-11.md, third
 * amendment). This checkbox shows what this browser does now and overrides
 * the device default either way; "Use device default" clears the override.
 *
 * Accessibility:
 *   - A native checkbox inside its label, so the name, the checked state and
 *     the Space key come from the browser.
 *   - The note under it is the checkbox's description (aria-describedby), so
 *     a screen reader hears whether the state is the device default or an
 *     override.
 *   - "Use device default" stays mounted and disabled when there is nothing
 *     to clear. Unmounting it would drop focus to the page behind the dialog.
 *     After a click, focus moves to the checkbox for the same reason.
 *
 * State lives in `src/lib/live-save-device.ts`; the two
 * `useSyncExternalStore` reads re-render this when the override changes in
 * this tab and unsubscribe on unmount.
 */

import { useId, useRef, useSyncExternalStore } from 'react';
import {
  getLiveSaveOverride,
  isLiveSaveDevice,
  isTouchFirstDevice,
  setLiveSaveOverride,
  subscribeLiveSaveDevice,
} from '../../lib/live-save-device';

function onOff(on: boolean): 'on' | 'off' {
  return on ? 'on' : 'off';
}

export function LiveSaveSwitch() {
  const noteId = useId();
  const switchRef = useRef<HTMLInputElement>(null);
  const saving = useSyncExternalStore(
    subscribeLiveSaveDevice,
    isLiveSaveDevice,
  );
  const override = useSyncExternalStore(
    subscribeLiveSaveDevice,
    getLiveSaveOverride,
  );
  const deviceDefault = onOff(!isTouchFirstDevice());

  const note =
    override === null
      ? `Default for this device: ${deviceDefault}`
      : `Overriding this device's default (${deviceDefault})`;

  const handleToggle = () => setLiveSaveOverride(onOff(!saving));
  const handleClearOverride = () => {
    setLiveSaveOverride(null);
    switchRef.current?.focus();
  };

  return (
    <div className="border-edge mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-md border px-3 py-2">
      <div className="min-w-0">
        <label className="flex cursor-pointer items-center gap-3">
          <input
            ref={switchRef}
            type="checkbox"
            checked={saving}
            onChange={handleToggle}
            aria-describedby={noteId}
            className="accent-accent h-4 w-4 cursor-pointer"
          />
          <span className="text-primary text-sm">
            Save live snapshots from this browser
          </span>
        </label>
        <p id={noteId} className="text-secondary mt-1 pl-7 text-xs">
          {note}
        </p>
      </div>
      <button
        type="button"
        onClick={handleClearOverride}
        disabled={override === null}
        className="border-edge-strong text-primary hover:bg-surface-alt rounded-lg border px-3 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      >
        Use device default
      </button>
    </div>
  );
}
