/**
 * useAccessSession — single React surface over the cookie-driven access mode.
 *
 * Returns the current `mode` ('owner' | 'guest' | 'public') plus a `refresh`
 * function (to be called after a successful guest-key login) and a `logout`
 * function (POSTs /api/auth/guest-logout, then notifies all subscribers).
 *
 * Multiple components can call this hook independently — they share a
 * module-level subscriber set so a `refresh` from one mount notifies all
 * mounts. No React Context required; the cost is one Set per app load.
 *
 * The owner Schwab session is unaffected by `logout`. A user who is both
 * owner and guest stays owner after signing out as guest.
 */

import { useCallback, useEffect, useState } from 'react';
import { getAccessMode, type AccessMode } from '../utils/auth';

const subscribers = new Set<() => void>();

function notifyAll(): void {
  for (const s of subscribers) s();
}

export interface AccessSession {
  mode: AccessMode;
  refresh: () => void;
  logout: () => Promise<void>;
}

export function useAccessSession(): AccessSession {
  const [mode, setMode] = useState<AccessMode>(() => getAccessMode());

  useEffect(() => {
    const update = (): void => setMode(getAccessMode());
    subscribers.add(update);
    return (): void => {
      subscribers.delete(update);
    };
  }, []);

  const refresh = useCallback((): void => {
    notifyAll();
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    try {
      await fetch('/api/auth/guest-logout', { method: 'POST' });
    } finally {
      notifyAll();
    }
  }, []);

  return { mode, refresh, logout };
}
