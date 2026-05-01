/**
 * useMultiWindowDeltas — keyed delta-map state for the GEX landscape.
 *
 * `GexLandscape/index.tsx` previously held five parallel `useState`
 * slots — one per lookback window (1m, 5m, 10m, 15m, 30m). Each slot
 * held a `Map<strike, deltaPct | null>`, all five were updated in
 * lock-step inside the snapshot effect, and all five were cleared
 * together on date change. That structure made the panel hard to
 * extend (adding a 60m window meant touching ~10 sites) and made
 * "everything advances atomically" implicit rather than enforced by
 * the data model.
 *
 * This hook collapses the five slots into a single keyed map indexed
 * by window-minute and exposes:
 *
 *   - `deltaMaps[m]`  → `Map<strike, deltaPct | null>` for that window
 *                       (always returns a Map — never `undefined` for
 *                       a window declared in the constructor argument).
 *   - `setDeltaMaps`  → atomic update for one or more windows in a
 *                       single React commit. Pass `{ [m]: Map }` to
 *                       set the maps for one or more windows; windows
 *                       not present in the patch are left unchanged.
 *   - `clearAll`      → reset every window's map to empty in a single
 *                       commit. Used on date change.
 *
 * The keyed shape removes the "did we forget to clear the 30m map?"
 * footgun and lets the snapshot effect express its intent in one
 * call: "here are all five new maps, atomically".
 */

import { useCallback, useMemo, useState } from 'react';

/**
 * Per-window delta map. Strike → signed Δ% as a number (e.g. 0.05 for
 * +5%) or null when the window has no comparable snapshot yet. Empty
 * Map means "no data for this window" — the table renders an em-dash.
 */
export type DeltaMap = Map<number, number | null>;

/** Patch shape: a partial mapping from window-minutes to fresh DeltaMaps. */
export type DeltaMapsPatch = Record<number, DeltaMap>;

export interface MultiWindowDeltasController {
  /**
   * Indexed delta maps. Always populated for each window passed to
   * `useMultiWindowDeltas`; the value is an empty `Map` until the
   * snapshot effect provides data.
   */
  deltaMaps: Record<number, DeltaMap>;
  /**
   * Atomically update one or more windows. Windows omitted from
   * `patch` are left unchanged — call with `{1: m1, 5: m5, ...}` to
   * update them all in a single React commit.
   */
  setDeltaMaps: (patch: DeltaMapsPatch) => void;
  /** Reset every window to a fresh empty Map in a single commit. */
  clearAll: () => void;
}

function buildEmptyMaps(windows: readonly number[]): Record<number, DeltaMap> {
  const out: Record<number, DeltaMap> = {};
  for (const w of windows) {
    out[w] = new Map();
  }
  return out;
}

/**
 * Hook factory. Pass the lookback windows (in minutes) you want to
 * track; the returned controller's `deltaMaps` always exposes one
 * entry per window. The `windows` argument is captured at first
 * mount — pass a stable array (module-level const or `useMemo`) to
 * avoid resetting state on every render.
 *
 * Note on stability: the hook does NOT diff the `windows` argument
 * across renders. If you change which windows you track at runtime,
 * mount a new instance instead of mutating the input.
 */
export function useMultiWindowDeltas(
  windows: readonly number[],
): MultiWindowDeltasController {
  // Snapshot of the windows array used for `clearAll`. We freeze the
  // initial value so the hook is hermetic against parents that pass a
  // new array literal each render.
  const stableWindows = useMemo(
    () => [...windows],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- captured-at-mount is intentional.
    [],
  );
  const [deltaMaps, setState] = useState<Record<number, DeltaMap>>(() =>
    buildEmptyMaps(stableWindows),
  );

  const setDeltaMaps = useCallback((patch: DeltaMapsPatch) => {
    setState((prev) => {
      // No-op when the patch only contains windows not in our state —
      // saves a render in the (rare) case of a stale write.
      let changed = false;
      const next = { ...prev };
      for (const key of Object.keys(patch)) {
        const w = Number(key);
        if (!(w in prev)) continue;
        const newMap = patch[w];
        if (newMap == null) continue;
        next[w] = newMap;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, []);

  const clearAll = useCallback(() => {
    setState(() => buildEmptyMaps(stableWindows));
  }, [stableWindows]);

  return { deltaMaps, setDeltaMaps, clearAll };
}
