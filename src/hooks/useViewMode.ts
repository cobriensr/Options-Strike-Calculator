import { useCallback, useEffect, useState } from 'react';

export type ViewMode = 'calculator' | 'alerts';

const ALERTS_HASH = '#alerts';

/** Parse the current location hash, tolerating a leading '#' and a '?...' query suffix. */
function readViewFromHash(): ViewMode {
  const raw = (globalThis.location?.hash ?? '')
    .replace(/^#/, '')
    .split('?')[0];
  return raw === 'alerts' ? 'alerts' : 'calculator';
}

/**
 * Top-level view switch backed by `window.location.hash`.
 *
 *   - `#alerts` (optionally with a `?...` suffix) → 'alerts'
 *   - empty / anything else                       → 'calculator' (default)
 *
 * Navigation uses `history.pushState` for BOTH directions so browser
 * Back/Forward round-trips symmetrically between the two views. A
 * `popstate` listener syncs state on Back/Forward; a `hashchange`
 * listener syncs state on manual address-bar hash edits.
 */
export function useViewMode(): {
  view: ViewMode;
  setView: (view: ViewMode) => void;
} {
  const [view, setViewState] = useState<ViewMode>(readViewFromHash);

  useEffect(() => {
    const sync = () => setViewState(readViewFromHash());
    globalThis.addEventListener('hashchange', sync);
    globalThis.addEventListener('popstate', sync);
    return () => {
      globalThis.removeEventListener('hashchange', sync);
      globalThis.removeEventListener('popstate', sync);
    };
  }, []);

  const setView = useCallback((next: ViewMode) => {
    const url =
      next === 'alerts'
        ? ALERTS_HASH
        : globalThis.location.pathname + globalThis.location.search;
    // pushState (not hash assignment) keeps both directions symmetric and
    // does not emit hashchange, so this manual setState is the sole update.
    globalThis.history.pushState(null, '', url);
    setViewState(next);
  }, []);

  return { view, setView };
}
