/**
 * Which browser saves live snapshots, and the per-browser switch that
 * overrides the default.
 *
 * Phones and tablets don't save live snapshots by default; computers do. The
 * missed-snapshot alert watches the trading computer, and a phone that opens
 * the app from the alert would otherwise save one row and make the stall
 * look over (docs/superpowers/specs/live-snapshot-alert-2026-11-11.md,
 * third amendment). The switch in the panel preferences dialog overrides the
 * default either way.
 *
 * No React in here, so code outside the component tree (a module started in
 * main.tsx) can read it as well as hooks and components. Same small
 * subscriber-set pattern as `sw-update.ts`, so a component re-renders when
 * the switch flips in this tab. Nothing is cached: every call reads
 * `localStorage`. Other tabs are never notified (there is no `storage`
 * listener in this module), so a consumer that must follow another tab's
 * change re-reads `isLiveSaveDevice()` at the moment it acts.
 * `live-session-signal.ts` keeps a `storage` listener of its own, which
 * refreshes its switch-off baseline.
 */

const STORAGE_KEY = 'sc-live-save-device';

/**
 * A touch-first device: its primary pointer is coarse and cannot hover. A
 * touchscreen laptop doesn't match, because its primary pointer is the
 * trackpad or mouse.
 */
const TOUCH_FIRST_QUERY = '(hover: none) and (pointer: coarse)';

export type LiveSaveOverride = 'on' | 'off';

const subscribers = new Set<() => void>();

function notifyAll(): void {
  for (const s of subscribers) s();
}

/**
 * Whether the primary input is touch (a phone or tablet). Where there is no
 * `window` or no `matchMedia`, it reads as a computer, which keeps saving as
 * it did before the device rule.
 */
export function isTouchFirstDevice(): boolean {
  if (
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function'
  ) {
    return false;
  }
  return window.matchMedia(TOUCH_FIRST_QUERY).matches;
}

/**
 * The stored choice, or null for "use the device default". An unknown stored
 * value and a storage that throws (blocked storage) both read as no choice.
 */
export function getLiveSaveOverride(): LiveSaveOverride | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'on' || stored === 'off' ? stored : null;
  } catch {
    return null;
  }
}

/**
 * Stores the choice, or clears it with null, then tells subscribers in this
 * tab. A storage failure never throws: a storage that throws can't keep the
 * choice, so it reads as no override afterwards. A subscriber that throws
 * does propagate to the caller, because subscribers run unguarded (as in
 * `sw-update.ts`); a subscriber must not throw.
 */
export function setLiveSaveOverride(value: LiveSaveOverride | null): void {
  try {
    if (value === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Blocked storage: nothing to keep. The next read sees no override.
  }
  notifyAll();
}

/** Whether this browser saves live snapshots: the override, else the device. */
export function isLiveSaveDevice(): boolean {
  const override = getLiveSaveOverride();
  if (override !== null) return override === 'on';
  return !isTouchFirstDevice();
}

/**
 * Calls `cb` after every `setLiveSaveOverride` in this tab. Other tabs are not
 * notified; re-read `isLiveSaveDevice()` when it matters. Returns the
 * unsubscribe.
 */
export function subscribeLiveSaveDevice(cb: () => void): () => void {
  subscribers.add(cb);
  return (): void => {
    subscribers.delete(cb);
  };
}
