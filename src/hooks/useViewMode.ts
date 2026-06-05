import { useCallback, useEffect, useState } from 'react';

export type ViewMode = 'calculator' | 'alerts';

const ALERTS_HASH = '#alerts';

function readViewFromHash(): ViewMode {
  return globalThis.location?.hash === ALERTS_HASH ? 'alerts' : 'calculator';
}

/**
 * Top-level view switch backed by `window.location.hash`.
 *
 *   - `#alerts`            → 'alerts'
 *   - empty / anything else → 'calculator' (default)
 *
 * Subscribes to `hashchange` so browser back/forward and bookmarked
 * `#alerts` deep-links stay in sync. `setView` is the imperative path
 * (header toggle); it writes the hash AND sets state so the update is
 * deterministic even though clearing the hash via replaceState does not
 * emit a `hashchange`.
 */
export function useViewMode(): {
  view: ViewMode;
  setView: (view: ViewMode) => void;
} {
  const [view, setViewState] = useState<ViewMode>(readViewFromHash);

  useEffect(() => {
    const onHashChange = () => setViewState(readViewFromHash());
    globalThis.addEventListener('hashchange', onHashChange);
    return () => globalThis.removeEventListener('hashchange', onHashChange);
  }, []);

  const setView = useCallback((next: ViewMode) => {
    if (next === 'alerts') {
      // Setting a new hash emits `hashchange`; the effect would also catch
      // it, but we set state directly for an immediate, deterministic update.
      globalThis.location.hash = 'alerts';
    } else {
      // Clear the hash without leaving a bare "#" or scroll-jumping.
      globalThis.history.replaceState(
        null,
        '',
        globalThis.location.pathname + globalThis.location.search,
      );
    }
    setViewState(next);
  }, []);

  return { view, setView };
}
