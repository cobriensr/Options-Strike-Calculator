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
 * `PUT` that bundles per-axis changes — only the axes the user actually
 * touched get sent. The server merges via partial-update semantics
 * (api/panel-prefs.ts) so untouched axes stay untouched. This matters
 * for two scenarios:
 *
 *   - A toggle followed by a drag both land in one PUT body, both
 *     axes touched, both persisted.
 *   - A toggle dispatched BEFORE the initial GET resolves correctly
 *     scopes the eventual PUT to just `hiddenPanels`, so the stored
 *     `panelOrder` + `groupOrder` aren't clobbered by client-side
 *     defaults.
 *
 * Same pattern covers `pagehide` / `visibilitychange→hidden` / unmount
 * via `flushPending()` + `fetch(..., { keepalive: true })`, so
 * cmd+shift+r, tab close, and mobile-backgrounded PWA paths persist
 * the user's last change rather than dropping the in-flight 500 ms
 * debounce.
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

/**
 * The PUT body sent to /api/panel-prefs. All three axes are optional
 * — only the ones the user has touched since last sync are included,
 * so the server's partial-update merge preserves the rest.
 */
interface PartialBody {
  hiddenPanels?: string[];
  panelOrder?: string[];
  groupOrder?: string[];
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
  // if React state has moved on, AND so the GET handler can check
  // axis-presence to avoid clobbering user changes that happened
  // pre-load. Keys present = "user touched this axis"; cleared after a
  // successful send.
  const pendingBodyRef = useRef<PartialBody>({});

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
        // Only apply axes the user HASN'T touched since mount —
        // otherwise the GET overwrites the user's pre-load toggle /
        // drag with stored state. Touched-axis presence is encoded as
        // key presence in pendingBodyRef.
        const pending = pendingBodyRef.current;
        if (!('hiddenPanels' in pending)) {
          setHidden(new Set(data.hiddenPanels));
        }
        if (!('panelOrder' in pending)) {
          setOrderState(data.panelOrder ?? []);
        }
        if (!('groupOrder' in pending)) {
          setGroupOrderState(data.groupOrder ?? []);
        }
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

  const sendPut = useCallback((body: PartialBody, keepalive: boolean) => {
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
    (patch: PartialBody) => {
      if (initialMode === 'public') return;
      // Merge the new per-axis change into the pending body. Earlier
      // touches stick around so a toggle + drag in the same debounce
      // window both make it into one PUT.
      pendingBodyRef.current = { ...pendingBodyRef.current, ...patch };
      if (pendingPutRef.current) clearTimeout(pendingPutRef.current);
      pendingPutRef.current = setTimeout(() => {
        const body = pendingBodyRef.current;
        if (Object.keys(body).length > 0) {
          // Optimistic update stays on failure; user can re-toggle /
          // re-drag to retry. Reverting silently would look like the
          // UI is broken.
          sendPut(body, false);
          pendingBodyRef.current = {};
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
    const body = pendingBodyRef.current;
    if (Object.keys(body).length > 0) {
      sendPut(body, true);
      pendingBodyRef.current = {};
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
        persist({ hiddenPanels: [...next] });
        return next;
      });
    },
    [persist],
  );

  const reset = useCallback(() => {
    setHidden(new Set());
    persist({ hiddenPanels: [] });
  }, [persist]);

  const setOrder = useCallback(
    (ids: readonly string[]) => {
      const nextOrder = [...ids];
      setOrderState(nextOrder);
      persist({ panelOrder: nextOrder });
    },
    [persist],
  );

  const resetPanelOrder = useCallback(() => {
    setOrderState([]);
    persist({ panelOrder: [] });
  }, [persist]);

  const setGroupOrder = useCallback(
    (groups: readonly string[]) => {
      const nextGroupOrder = [...groups];
      setGroupOrderState(nextGroupOrder);
      persist({ groupOrder: nextGroupOrder });
    },
    [persist],
  );

  const resetGroupOrder = useCallback(() => {
    setGroupOrderState([]);
    persist({ groupOrder: [] });
  }, [persist]);

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
