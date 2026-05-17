/**
 * usePanelPrefs — per-identity show/hide panel preferences.
 *
 * Reads `hidden_panels` from `GET /api/panel-prefs` on mount (skipped for
 * public visitors who have no server-side row). Mutations are optimistic:
 * `toggle` updates local state synchronously and schedules a debounced
 * `PUT` so rapidly flipping 10 checkboxes collapses into one network
 * round-trip. A failed PUT keeps the optimistic state — the user can
 * re-toggle to retry — rather than reverting silently, which would feel
 * like the checkbox is broken.
 *
 * `isLoaded` is true immediately for public visitors (no fetch) and
 * flips true on owner/guest after the GET resolves (success or failure).
 * Callers can gate render on `isLoaded` to avoid a flash-of-all-panels
 * for returning users with hides set.
 *
 * Spec: docs/superpowers/specs/panel-prefs-2026-05-17.md
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAccessMode } from '../utils/auth.js';

const DEBOUNCE_MS = 500;

export interface PanelPrefs {
  hidden: ReadonlySet<string>;
  isHidden: (id: string) => boolean;
  toggle: (id: string) => void;
  reset: () => void;
  isLoaded: boolean;
}

interface PanelPrefsResponse {
  hiddenPanels: string[];
}

export function usePanelPrefs(): PanelPrefs {
  const initialMode = useRef(getAccessMode()).current;
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [isLoaded, setIsLoaded] = useState(() => initialMode === 'public');
  const pendingPutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (initialMode === 'public') return;
    const abort = new AbortController();
    void (async () => {
      try {
        const res = await fetch('/api/panel-prefs', { signal: abort.signal });
        if (!res.ok) {
          setIsLoaded(true);
          return;
        }
        const data = (await res.json()) as PanelPrefsResponse;
        setHidden(new Set(data.hiddenPanels));
        setIsLoaded(true);
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setIsLoaded(true);
      }
    })();
    return () => {
      abort.abort();
    };
  }, [initialMode]);

  const persist = useCallback(
    (nextHidden: Set<string>) => {
      if (initialMode === 'public') return;
      if (pendingPutRef.current) clearTimeout(pendingPutRef.current);
      pendingPutRef.current = setTimeout(() => {
        // Optimistic update stays on failure; user can re-toggle to retry.
        // Reverting would look like the checkbox is broken.
        fetch('/api/panel-prefs', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hiddenPanels: [...nextHidden] }),
        }).catch(() => undefined);
      }, DEBOUNCE_MS);
    },
    [initialMode],
  );

  useEffect(
    () => () => {
      if (pendingPutRef.current) clearTimeout(pendingPutRef.current);
    },
    [],
  );

  const isHidden = useCallback((id: string) => hidden.has(id), [hidden]);

  const toggle = useCallback(
    (id: string) => {
      setHidden((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const reset = useCallback(() => {
    const next = new Set<string>();
    setHidden(next);
    persist(next);
  }, [persist]);

  // Stable object reference: without useMemo, the return is a fresh
  // literal every render, which breaks downstream useMemo caches that
  // depend on `panelPrefs` (e.g., App.tsx's `navSections` filter). The
  // inner refs (hidden Set, useCallback fns) only change when their own
  // deps change, so this memo lets identity flow through.
  return useMemo(
    () => ({ hidden, isHidden, toggle, reset, isLoaded }),
    [hidden, isHidden, toggle, reset, isLoaded],
  );
}
