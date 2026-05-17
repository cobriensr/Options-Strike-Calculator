/**
 * usePanelPrefs — per-identity panel preferences across three axes:
 *
 *   1. visibility — which panels are hidden (`hidden_panels`)
 *   2. panel order — drag-reordered ids within each group (`panel_order`)
 *   3. group order — drag-reordered group names (`group_order`)
 *
 * Reads all three from `GET /api/panel-prefs` on mount (skipped for
 * public visitors who have no server-side row). Mutations are optimistic:
 * setters update local state synchronously and schedule a debounced
 * `PUT` so rapidly flipping 10 checkboxes / dragging a panel a few times
 * collapses into one network round-trip. Every PUT sends all three axes
 * — partial-update semantics live on the server (see api/panel-prefs.ts)
 * but the normal flow uses full sends so client state is the source of
 * truth.
 *
 * A failed PUT keeps the optimistic state — the user can re-toggle /
 * re-drag to retry — rather than reverting silently, which would feel
 * like the UI is broken.
 *
 * `isLoaded` is true immediately for public visitors (no fetch) and
 * flips true on owner/guest after the GET resolves (success or failure).
 * Callers can gate render on `isLoaded` to avoid a flash-of-default
 * layout for returning users with customized order.
 *
 * Specs:
 *   - docs/superpowers/specs/panel-prefs-2026-05-17.md (visibility)
 *   - docs/superpowers/specs/panel-reordering-2026-05-17.md (orders)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAccessMode } from '../utils/auth.js';

const DEBOUNCE_MS = 500;

export interface PanelPrefs {
  // Visibility (axis 1)
  hidden: ReadonlySet<string>;
  isHidden: (id: string) => boolean;
  toggle: (id: string) => void;
  reset: () => void;

  // Panel order within group (axis 2)
  order: readonly string[];
  setOrder: (ids: readonly string[]) => void;
  resetPanelOrder: () => void;

  // Group order (axis 3)
  groupOrder: readonly string[];
  setGroupOrder: (groups: readonly string[]) => void;
  resetGroupOrder: () => void;

  isLoaded: boolean;
}

interface PanelPrefsResponse {
  hiddenPanels: string[];
  panelOrder?: string[];
  groupOrder?: string[];
}

interface PendingPut {
  hiddenPanels: string[];
  panelOrder: string[];
  groupOrder: string[];
}

export function usePanelPrefs(): PanelPrefs {
  const initialMode = useRef(getAccessMode()).current;
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [order, setOrderState] = useState<readonly string[]>(() => []);
  const [groupOrder, setGroupOrderState] = useState<readonly string[]>(
    () => [],
  );
  const [isLoaded, setIsLoaded] = useState(() => initialMode === 'public');
  const pendingPutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The latest body the debounce timer will send. Held in a ref so the
  // flush path (pagehide / unmount) can grab the most recent state even
  // if React state has moved on. Cleared after a successful send.
  const pendingBodyRef = useRef<PendingPut | null>(null);

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
        setOrderState(data.panelOrder ?? []);
        setGroupOrderState(data.groupOrder ?? []);
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

  const sendPut = useCallback((body: PendingPut, keepalive: boolean) => {
    // `keepalive: true` lets the request outlive the page when fired
    // from a pagehide / unmount handler — that's how cmd+shift+r and
    // tab-close paths persist the user's latest drag/toggle instead
    // of dropping the in-flight debounce timer.
    fetch('/api/panel-prefs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive,
    }).catch(() => undefined);
  }, []);

  const persist = useCallback(
    (next: PendingPut) => {
      if (initialMode === 'public') return;
      pendingBodyRef.current = next;
      if (pendingPutRef.current) clearTimeout(pendingPutRef.current);
      pendingPutRef.current = setTimeout(() => {
        const body = pendingBodyRef.current;
        if (body) {
          // Optimistic update stays on failure; user can re-toggle /
          // re-drag to retry. Reverting silently would look like the
          // UI is broken.
          sendPut(body, false);
          pendingBodyRef.current = null;
        }
        pendingPutRef.current = null;
      }, DEBOUNCE_MS);
    },
    [initialMode, sendPut],
  );

  // Flush the latest pending body immediately. Called on hook unmount
  // AND on pagehide / visibility-hidden so cmd+shift+r, tab close, and
  // mobile-backgrounded PWA paths all persist the user's last action
  // instead of dropping the in-flight 500 ms debounce.
  const flushPending = useCallback(() => {
    if (pendingPutRef.current) {
      clearTimeout(pendingPutRef.current);
      pendingPutRef.current = null;
    }
    if (pendingBodyRef.current) {
      sendPut(pendingBodyRef.current, true);
      pendingBodyRef.current = null;
    }
  }, [sendPut]);

  useEffect(() => {
    if (initialMode === 'public') return;
    const onPageHide = () => flushPending();
    // pagehide doesn't fire on iOS Safari when the user swipes the
    // browser away — visibilitychange→hidden does, so listen to both.
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushPending();
    };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      // Final flush on component unmount — covers SPA teardown paths
      // that don't trigger pagehide.
      flushPending();
    };
  }, [initialMode, flushPending]);

  const isHidden = useCallback((id: string) => hidden.has(id), [hidden]);

  const toggle = useCallback(
    (id: string) => {
      setHidden((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        persist({
          hiddenPanels: [...next],
          panelOrder: [...order],
          groupOrder: [...groupOrder],
        });
        return next;
      });
    },
    [persist, order, groupOrder],
  );

  const reset = useCallback(() => {
    const next = new Set<string>();
    setHidden(next);
    persist({
      hiddenPanels: [],
      panelOrder: [...order],
      groupOrder: [...groupOrder],
    });
  }, [persist, order, groupOrder]);

  const setOrder = useCallback(
    (ids: readonly string[]) => {
      const nextOrder = [...ids];
      setOrderState(nextOrder);
      persist({
        hiddenPanels: [...hidden],
        panelOrder: nextOrder,
        groupOrder: [...groupOrder],
      });
    },
    [persist, hidden, groupOrder],
  );

  const resetPanelOrder = useCallback(() => {
    setOrderState([]);
    persist({
      hiddenPanels: [...hidden],
      panelOrder: [],
      groupOrder: [...groupOrder],
    });
  }, [persist, hidden, groupOrder]);

  const setGroupOrder = useCallback(
    (groups: readonly string[]) => {
      const nextGroupOrder = [...groups];
      setGroupOrderState(nextGroupOrder);
      persist({
        hiddenPanels: [...hidden],
        panelOrder: [...order],
        groupOrder: nextGroupOrder,
      });
    },
    [persist, hidden, order],
  );

  const resetGroupOrder = useCallback(() => {
    setGroupOrderState([]);
    persist({
      hiddenPanels: [...hidden],
      panelOrder: [...order],
      groupOrder: [],
    });
  }, [persist, hidden, order]);

  // Stable object reference: without useMemo, the return is a fresh
  // literal every render, which breaks downstream useMemo caches that
  // depend on `panelPrefs` (e.g., App.tsx's `navSections` filter). The
  // inner refs (hidden Set, useCallback fns) only change when their own
  // deps change, so this memo lets identity flow through.
  return useMemo(
    () => ({
      hidden,
      isHidden,
      toggle,
      reset,
      order,
      setOrder,
      resetPanelOrder,
      groupOrder,
      setGroupOrder,
      resetGroupOrder,
      isLoaded,
    }),
    [
      hidden,
      isHidden,
      toggle,
      reset,
      order,
      setOrder,
      resetPanelOrder,
      groupOrder,
      setGroupOrder,
      resetGroupOrder,
      isLoaded,
    ],
  );
}
