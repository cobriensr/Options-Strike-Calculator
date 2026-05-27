/**
 * useIntervalBAMute — local-only mute switch for the Interval B/A alert
 * banner + chime + browser notifications.
 *
 * Stored in localStorage (not server `panel-prefs`) on purpose: a "shut
 * up right now" control needs to apply synchronously on the next paint
 * with zero network dependency, and it's per-device by nature — a guest
 * silencing alerts on their phone shouldn't mute their desktop.
 *
 * The polling itself keeps running while muted so re-enabling surfaces
 * the actual backlog of what fired during the mute window, not a stale
 * snapshot. See {@link useIntervalBAAlerts} for the gate.
 */
import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'sc-interval-ba-muted-v1';

function readMuted(): boolean {
  if (typeof window === 'undefined' || !window.localStorage) return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeMuted(value: boolean): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    if (value) {
      window.localStorage.setItem(STORAGE_KEY, '1');
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // quota / private mode — best effort
  }
}

export interface IntervalBAMuteState {
  muted: boolean;
  setMuted: (value: boolean) => void;
  toggle: () => void;
}

export function useIntervalBAMute(): IntervalBAMuteState {
  const [muted, setMutedState] = useState<boolean>(readMuted);

  useEffect(() => {
    writeMuted(muted);
  }, [muted]);

  const setMuted = useCallback((value: boolean) => {
    setMutedState(value);
  }, []);

  const toggle = useCallback(() => {
    setMutedState((prev) => !prev);
  }, []);

  return { muted, setMuted, toggle };
}
