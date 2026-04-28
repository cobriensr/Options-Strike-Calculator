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
import { AUTH_CLEARED_EVENT } from '../utils/authInterceptor';

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
    // The auth interceptor clears stale hint cookies after a 401 and
    // dispatches AUTH_CLEARED_EVENT. Re-evaluate mode so the Sign-in CTA
    // appears the moment the server tells us the session is gone.
    window.addEventListener(AUTH_CLEARED_EVENT, update);
    return (): void => {
      subscribers.delete(update);
      window.removeEventListener(AUTH_CLEARED_EVENT, update);
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
