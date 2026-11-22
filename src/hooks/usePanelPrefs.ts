/**
 * usePanelPrefs — per-identity panel preferences across three axes:
 *
 *   1. visibility — which panels are hidden (`hidden_panels`)
 *   2. panel order — drag-reordered ids within each group (`panel_order`)
 *   3. group order — drag-reordered group names (`group_order`)
 *
 * State is seeded synchronously from localStorage on mount so refreshes
 * (incl. cmd+shift+r) don't flash default visibility/order before the
 * async server GET resolves. Without that cache, App.tsx briefly renders
 * every panel in registry order, which reads to the user as "selection
 * lost and random other panels showing".
 *
 * Owner/guest sessions also `GET /api/panel-prefs` on mount and apply
 * server state to axes the user hasn't touched since mount, keeping the
 * "follows you across devices" guarantee — localStorage is just the
 * paint-on-mount cache. Public visitors skip the server round-trip
 * entirely; localStorage is their only store.
 *
 * The access mode is read live, so it can change without a remount. A
 * public visitor who signs in with a guest key gets the same GET and the
 * same PUTs from that moment on. The GET applies each axis by the mount
 * rule, so the guest's saved layout wins over an edit made while public
 * (as on a reload), and such an edit is never queued, so never sent. A
 * guest or owner whose access drops to public stops sending, and an edit
 * still queued at that moment is dropped (the cookie is gone, so the PUT
 * could only 401).
 *
 * An axis edited as an owner or guest since the GET began is never
 * overwritten by its reply, even when the debounce has already sent it
 * (`touchedAxesRef`), so a slow GET cannot undo a fresh edit.
 *
 * Mutations are optimistic: setters update local state synchronously,
 * write to localStorage via the `[hidden, order, groupOrder]` effect,
 * and schedule a debounced `PUT` that bundles per-axis changes — only
 * the axes the user actually touched get sent. The server merges via
 * partial-update semantics (api/panel-prefs.ts) so untouched axes stay
 * untouched. This matters for two scenarios:
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
 * It follows the live mode: it is false for a guest while that sign-in's
 * GET is in flight, and true again on a drop to public.
 * Callers can gate render on `isLoaded` to avoid a flash-of-default
 * layout for returning users with customized order.
 *
 * Specs:
 *   - docs/superpowers/specs/panel-prefs-2026-05-17.md (visibility)
 *   - docs/superpowers/specs/panel-reordering-2026-05-17.md (orders)
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { getAccessMode, type AccessMode } from '../utils/auth.js';

const DEBOUNCE_MS = 500;
const STORAGE_KEY = 'sc-panel-prefs-v1';

interface StoredPrefs {
  hiddenPanels: string[];
  panelOrder: string[];
  groupOrder: string[];
}

const EMPTY_STORED: StoredPrefs = {
  hiddenPanels: [],
  panelOrder: [],
  groupOrder: [],
};

/**
 * Synchronously read panel preferences from localStorage. Returning a
 * fully-populated `StoredPrefs` (with empty arrays as the fallback)
 * keeps the `useState` initializer call sites trivial.
 */
function readStoredPrefs(): StoredPrefs {
  if (typeof window === 'undefined' || !window.localStorage) {
    return EMPTY_STORED;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_STORED;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return EMPTY_STORED;
    const p = parsed as Partial<StoredPrefs>;
    return {
      hiddenPanels: Array.isArray(p.hiddenPanels)
        ? p.hiddenPanels.filter((x): x is string => typeof x === 'string')
        : [],
      panelOrder: Array.isArray(p.panelOrder)
        ? p.panelOrder.filter((x): x is string => typeof x === 'string')
        : [],
      groupOrder: Array.isArray(p.groupOrder)
        ? p.groupOrder.filter((x): x is string => typeof x === 'string')
        : [],
    };
  } catch {
    // corrupt JSON, quota inspection, or disabled storage — fall back
    return EMPTY_STORED;
  }
}

function writeStoredPrefs(prefs: StoredPrefs): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // quota exceeded, private mode, or storage disabled — best-effort
  }
}

/**
 * Should the GET response replace the localStorage-seeded state for
 * this axis?
 *
 * The keepalive PUT fired from cmd+shift+r / tab-close can drop on
 * the floor (the `.catch(() => undefined)` in `sendPut` swallows
 * network errors), leaving the DB stale while localStorage holds the
 * user's latest order/visibility. If the next mount's GET then
 * returns the stale empty arrays, we used to overwrite the fresh
 * localStorage seed and the post-state effect would re-write the
 * empty arrays back to localStorage — wiping the user's panel order
 * across a reload.
 *
 * Rule: apply the server value EXCEPT when it would clear a
 * non-empty local seed. That preserves cross-device sync when the
 * server actually has data, while protecting "I changed locally but
 * the PUT didn't make it to the server before reload" from silent
 * destruction. Single-owner deployment (see CLAUDE.md "Auth is
 * single-owner") means the cross-device-clears-everything edge case
 * is rare; the reload-loses-my-work case happens every keepalive
 * miss.
 */
function shouldApplyServerAxis(
  server: readonly string[],
  local: readonly string[],
): boolean {
  return !(server.length === 0 && local.length > 0);
}

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

type AxisKey = keyof PartialBody;
const AXES: readonly AxisKey[] = ['hiddenPanels', 'panelOrder', 'groupOrder'];

export function usePanelPrefs(): PanelPrefs {
  // The live access mode, read at every render and never frozen in a ref or
  // state: App re-renders this hook on each mode change (useAccessSession), so
  // a guest key entered without a reload loads and saves that guest's server
  // layout, and a drop to public stops the requests.
  const mode = getAccessMode();
  // Synchronous localStorage seed — paints last-known visibility/order
  // before the async server GET resolves. `useMemo` with empty deps
  // runs once per mount so we don't re-parse on every render. The
  // initializer is idempotent (pure localStorage read), so React's
  // freedom to drop the memo result is harmless.
  const cached = useMemo(() => readStoredPrefs(), []);
  const [hidden, setHidden] = useState<Set<string>>(
    () => new Set(cached.hiddenPanels),
  );
  const [order, setOrderState] = useState<readonly string[]>(
    () => cached.panelOrder,
  );
  const [groupOrder, setGroupOrderState] = useState<readonly string[]>(
    () => cached.groupOrder,
  );
  // The mode whose server GET last settled, success or failure. `isLoaded`
  // is derived from it at render, so no render shows a guest as loaded before
  // that guest's own GET has answered. The public run resets it to null, so a
  // second sign-in waits for its own GET rather than reusing the first's.
  const [loadedMode, setLoadedMode] = useState<AccessMode | null>(null);
  const isLoaded = mode === 'public' || loadedMode === mode;
  const pendingPutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The latest body the debounce timer will send: the "not yet sent" queue
  // and nothing else. Held in a ref so the flush path (pagehide / unmount)
  // can grab the most recent state even if React state has moved on. Keys
  // present = "queued for the next send"; cleared after a send. Only an
  // owner or guest edit lands here: a public visitor's edit is never queued.
  const pendingBodyRef = useRef<PartialBody>({});
  // The axes the user edited, as an owner or guest, since the current GET run
  // began. The GET reply skips each of them, so it cannot overwrite an edit
  // the user made while it was out. Unlike the queue above, a send does not
  // clear it: the debounce can send an edit before a slow GET answers, and
  // the reply must still leave that axis alone. It is cleared when a run
  // starts, when a run has applied its reply, and when the queue is dropped.
  const touchedAxesRef = useRef<Set<AxisKey>>(new Set());
  // The layout on screen, for the GET reply to compare a server axis against
  // (not the mount-time seed). Written in a layout effect, not during render,
  // so it holds only a committed value, never one from a render React threw
  // away. No microtask can run between a commit and its layout effects, so the
  // reply still reads what is on screen.
  const latestRef = useRef({ hidden, order, groupOrder });
  useLayoutEffect(() => {
    latestRef.current = { hidden, order, groupOrder };
  }, [hidden, order, groupOrder]);

  // Mirror state to localStorage on every change so the next mount can
  // paint synchronously. Runs for all access modes (incl. public) — the
  // server PUT is still gated to owner/guest by `persist()`. The effect
  // also fires once on mount, re-writing the cached values back to
  // localStorage with normalized JSON, which fixes any partially-valid
  // payloads that `readStoredPrefs()` already coerced.
  useEffect(() => {
    writeStoredPrefs({
      hiddenPanels: [...hidden],
      panelOrder: [...order],
      groupOrder: [...groupOrder],
    });
  }, [hidden, order, groupOrder]);

  // Runs on mount and again whenever the access mode changes, so a guest key
  // entered without a reload loads that guest's layout, by the same rule a
  // reload uses. Re-running is safe: an axis edited since the run began is
  // skipped (`touchedAxesRef`), and the cleanup aborts a request a second
  // flip supersedes. An edit made while public is not protected: the saved
  // layout wins over it, and it was never queued, so it is never sent.
  useEffect(() => {
    if (mode === 'public') {
      // Nothing to load for a public visitor, and nothing loaded for any
      // identity. This also ends the wait of a GET a drop to public aborted.
      setLoadedMode(null);
      return;
    }
    touchedAxesRef.current.clear();
    const abort = new AbortController();
    // A reply is stale once its run was aborted, or once the live mode is no
    // longer the one this run started under: the cookie can go before App
    // re-renders the hook, and the reply can land in that gap.
    const isStale = () => abort.signal.aborted || getAccessMode() !== mode;
    void (async () => {
      try {
        const res = await fetch('/api/panel-prefs', { signal: abort.signal });
        if (isStale()) return;
        if (!res.ok) {
          setLoadedMode(mode);
          return;
        }
        const data = (await res.json()) as PanelPrefsResponse;
        if (isStale()) return;
        // Apply each axis by the mount rule, except one the user edited
        // since this run began: the GET must not overwrite an edit made
        // while it was out, even one the debounce has already sent. The
        // rule: apply the server value unless it would clear a non-empty
        // local one (see `shouldApplyServerAxis()` for why: keepalive PUT
        // loss across cmd+shift+r). "Local" is what is on screen as the
        // reply lands, which after a sign-in is not the mount-time seed.
        const touched = touchedAxesRef.current;
        const local = latestRef.current;
        const serverHidden = data.hiddenPanels;
        const serverOrder = data.panelOrder ?? [];
        const serverGroupOrder = data.groupOrder ?? [];
        if (
          !touched.has('hiddenPanels') &&
          shouldApplyServerAxis(serverHidden, [...local.hidden])
        ) {
          setHidden(new Set(serverHidden));
        }
        if (
          !touched.has('panelOrder') &&
          shouldApplyServerAxis(serverOrder, local.order)
        ) {
          setOrderState(serverOrder);
        }
        if (
          !touched.has('groupOrder') &&
          shouldApplyServerAxis(serverGroupOrder, local.groupOrder)
        ) {
          setGroupOrderState(serverGroupOrder);
        }
        touched.clear();
        setLoadedMode(mode);
      } catch (err) {
        if ((err as Error).name === 'AbortError' || isStale()) return;
        setLoadedMode(mode);
      }
    })();
    return () => {
      abort.abort();
    };
  }, [mode]);

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
      // A public visitor has no server layout to write. Their edit shows on
      // screen and reaches localStorage through the mirror effect above, but
      // it is never queued, so nothing can send it later: not under a guest
      // sign-in, whose saved layout wins over it.
      if (mode === 'public') return;
      for (const axis of AXES) {
        if (patch[axis] !== undefined) touchedAxesRef.current.add(axis);
      }
      // Merge the new per-axis change into the pending body. Earlier
      // touches stick around so a toggle + drag in the same debounce
      // window both make it into one PUT.
      pendingBodyRef.current = { ...pendingBodyRef.current, ...patch };
      if (pendingPutRef.current) clearTimeout(pendingPutRef.current);
      pendingPutRef.current = setTimeout(() => {
        // The cookie can change before App re-renders the hook and the
        // cleanup drops this timer. A PUT then would 401, or write this
        // edit into the other identity's layout: the same rule as the
        // flush cleanup below.
        if (getAccessMode() !== mode) return;
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
    [mode, sendPut],
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

  // Throw away what is queued, unsent. Used when the identity the edits were
  // made under is gone, so a PUT could only 401 (a drop to public) or would
  // write them into another identity's layout (owner and guest swap).
  const dropPending = useCallback(() => {
    if (pendingPutRef.current) {
      clearTimeout(pendingPutRef.current);
      pendingPutRef.current = null;
    }
    pendingBodyRef.current = {};
    touchedAxesRef.current.clear();
  }, []);

  useEffect(() => {
    if (mode === 'public') return;
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
      // that don't trigger pagehide. This cleanup also runs when the mode
      // changes, and by then the live mode is no longer the one the edits
      // were made under: drop them instead of sending.
      if (getAccessMode() === mode) flushPending();
      else dropPending();
    };
  }, [mode, flushPending, dropPending]);

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
